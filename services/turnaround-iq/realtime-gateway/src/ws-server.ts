import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

import { verifySessionToken } from "./ws-auth";
import { buildBatchFrame, OutboundQueue } from "./frames";
import type { Logger } from "./logger";

/**
 * ws server (api-contracts.md §3, architecture.md §5):
 * - connect: GET /api/ws?token=<short-lived jwt> — invalid token ⇒ close 4001
 * - client frames: {action: subscribe|unsubscribe, channel}
 * - server frames: wsFrameSchema envelopes; ≤ 10 Hz per client via 100 ms flush
 */

export const WS_PATH = "/api/ws";
const FLUSH_INTERVAL_MS = 100; // ≤ 10 Hz per client (architecture.md §6)

interface ClientSession {
  socket: WebSocket;
  queue: OutboundQueue;
  channels: Set<string>;
  userId: string;
}

export class RealtimeHub {
  private clients = new Map<string, ClientSession>();
  private wss: WebSocketServer;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly healthServer: Server,
  ) {
    this.wss = new WebSocketServer({ noServer: true });
    this.healthServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== WS_PATH) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        void this.handleConnection(ws, url);
      });
    });
  }

  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flushAll(), FLUSH_INTERVAL_MS);
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    for (const session of this.clients.values()) {
      session.socket.close(1001, "server shutting down");
    }
    this.clients.clear();
  }

  clientCount(): number {
    return this.clients.size;
  }

  private async handleConnection(ws: WebSocket, url: URL): Promise<void> {
    // Short-lived signed token at upgrade (architecture.md §5); rejected ⇒ 4001.
    const token = url.searchParams.get("token") ?? "";
    const claims = await verifySessionToken(token).catch(() => null);
    if (!claims) {
      ws.close(4001, "invalid or expired token");
      return;
    }

    const sessionId = randomUUID();
    const session: ClientSession = {
      socket: ws,
      queue: new OutboundQueue(),
      channels: new Set<string>(),
      userId: claims.sub,
    };
    this.clients.set(sessionId, session);
    this.logger.info({ msg: "ws connected", requestId: sessionId, userId: claims.sub });

    ws.on("message", (raw: unknown) => {
      this.handleClientMessage(sessionId, session, raw);
    });
    ws.on("close", () => {
      this.clients.delete(sessionId);
      this.logger.info({ msg: "ws disconnected", requestId: sessionId });
    });
    ws.on("error", (err: Error) => {
      this.logger.warn({ msg: "ws error", requestId: sessionId, err: err.message });
    });
  }

  private handleClientMessage(sessionId: string, session: ClientSession, raw: unknown): void {
    let parsed: { action?: string; channel?: string };
    try {
      parsed = JSON.parse(String(raw)) as { action?: string; channel?: string };
    } catch {
      return;
    }
    if (typeof parsed.action !== "string" || typeof parsed.channel !== "string") return;
    if (!isAllowedChannel(parsed.channel)) {
      this.logger.warn({
        msg: "rejected channel subscription",
        requestId: sessionId,
        channel: parsed.channel,
      });
      return;
    }
    if (parsed.action === "subscribe") session.channels.add(parsed.channel);
    if (parsed.action === "unsubscribe") session.channels.delete(parsed.channel);
  }

  /** Broadcast a frame to every client subscribed to at least one channel. */
  broadcast(channels: readonly string[], frame: unknown): void {
    for (const session of this.clients.values()) {
      if (!channels.some((channel) => session.channels.has(channel))) continue;
      session.queue.push(frame as never);
    }
  }

  private flushAll(): void {
    for (const session of this.clients.values()) {
      if (session.socket.readyState !== session.socket.OPEN) continue;
      const frames = session.queue.flush();
      if (frames.length === 0) continue;
      // ADR-0008: one socket write per client flush (batch envelope) instead
      // of one write per frame — the write count dominated fan-out latency.
      const wire = JSON.stringify(buildBatchFrame(frames, new Date().toISOString()));
      session.socket.send(wire);
    }
  }
}

/** Channels follow api-contracts.md §3: `board` and `flight:{uuid}`. */
export function isAllowedChannel(channel: string): boolean {
  if (channel === "board") return true;
  if (!channel.startsWith("flight:")) return false;
  const id = channel.slice("flight:".length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
