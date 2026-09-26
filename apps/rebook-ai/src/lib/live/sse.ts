import { eq } from "drizzle-orm";

import { createRedis } from "@aviation/db/redis";
import {
  rebookLiveFrameSchema,
  REBOOK_LIVE_CHANNEL,
  type RebookLiveFrame,
} from "@aviation/contracts";

import { pnr as pnrTable } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { resolveRedisUrl } from "@/lib/redis-url";

/**
 * SSE bridge (api-contracts.md §3, architecture.md §4): forwards validated
 * frames from `chan:rb:live` to the browser. ONE Redis subscription per
 * server process fans out to all connected clients in-process — per-client
 * subscribe/unsubscribe on shared or per-connection clients is exactly the
 * stacked-subscription failure mode D-14 documented, so there is nothing to
 * stack. Passenger streams are scoped to their own PNRs (ownership,
 * architecture.md §5); agent+ streams receive everything incl. queue.delta.
 */

const HEARTBEAT_MS = 15_000;

type FrameListener = (raw: string) => void;

interface LiveFanout {
  subscribe(listener: FrameListener): () => void;
}

const globalStore = globalThis as unknown as { __rebookLiveFanout?: Promise<LiveFanout> };

function getLiveFanout(): Promise<LiveFanout> {
  if (!globalStore.__rebookLiveFanout) {
    globalStore.__rebookLiveFanout = (async () => {
      const connection = await createRedis(resolveRedisUrl());
      const listeners = new Set<FrameListener>();
      await connection.redis.subscribe(REBOOK_LIVE_CHANNEL, (raw: string) => {
        for (const listener of listeners) listener(raw);
      });
      return {
        subscribe(listener: FrameListener): () => void {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    })();
  }
  return globalStore.__rebookLiveFanout;
}

export async function streamLive(
  session: { sub: string; role: "passenger" | "agent" | "supervisor" },
  onLog: (msg: string, fields?: Record<string, unknown>) => void,
): Promise<Response> {
  const fanout = await getLiveFanout();
  const agentPlus = session.role !== "passenger";

  const ownedPnrIds = new Set<string>();
  if (!agentPlus) {
    const db = getSingletonDb();
    const rows = await db
      .select({ id: pnrTable.id })
      .from(pnrTable)
      .where(eq(pnrTable.userId, session.sub));
    for (const row of rows) ownedPnrIds.add(row.id);
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string): void => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // stream already closed by the client
        }
      };
      const onFrame = (raw: string): void => {
        let frame: RebookLiveFrame;
        try {
          frame = rebookLiveFrameSchema.parse(JSON.parse(raw));
        } catch {
          return; // never forward an invalid frame (api-contracts.md §3)
        }
        if (!agentPlus) {
          if (frame.type === "queue.delta") return;
          if (!ownedPnrIds.has(frame.payload.pnrId)) return;
        }
        send(`data: ${JSON.stringify(frame)}\n\n`);
      };
      unsubscribe = fanout.subscribe(onFrame);
      send(": connected\n\n");
      heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      onLog("sse_client_connected", { role: session.role, owned: ownedPnrIds.size });
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
      onLog("sse_client_disconnected", { role: session.role });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
