"use client";

import { useEffect, useRef, useState } from "react";
import { serverFrameSchema, wsFrameSchema, type WsFrame } from "@aviation/contracts";

/**
 * Board websocket lifecycle (api-contracts.md §3, architecture.md §4): fetch a
 * short-lived ws token, connect to the gateway, subscribe to `board` (+ optional
 * flight channel) and surface validated frames. Reconnects with capped backoff;
 * callers refetch the REST snapshot on reconnect via the connection-state flag.
 */

export type SocketStatus = "connecting" | "open" | "closed";

interface UseBoardSocketOptions {
  /** Extra channel to subscribe, e.g. `flight:{id}` for the open drawer. */
  extraChannel?: string | null;
  onFrame: (frame: WsFrame) => void;
  /** Called after every (re)connect — refresh the REST snapshot for catch-up. */
  onReconnect?: () => void;
}

export function useBoardSocket({
  extraChannel,
  onFrame,
  onReconnect,
}: UseBoardSocketOptions): SocketStatus {
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const frameHandler = useRef(onFrame);
  frameHandler.current = onFrame;
  const reconnectHandler = useRef(onReconnect);
  reconnectHandler.current = onReconnect;
  const extraChannelRef = useRef(extraChannel);
  extraChannelRef.current = extraChannel;
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 500;
    let currentSocket: WebSocket | null = null;
    // Channels whose subscribe frame was sent on THIS socket (starts empty —
    // the pre-seeded variant never sent "board" and the hub never subscribed
    // us; caught by the F3 e2e).
    const subscribed = new Set<string>();

    const sendSubscribe = (socket: WebSocket, channel: string): void => {
      if (!subscribed.has(channel)) {
        socket.send(JSON.stringify({ action: "subscribe", channel }));
        subscribed.add(channel);
      }
    };

    const connect = (): void => {
      if (disposed) return;
      setStatus((s) => (s === "open" ? s : "connecting"));
      void (async () => {
        try {
          const res = await fetch("/api/v1/auth/ws-token", { method: "POST" });
          if (!res.ok) throw new Error(`ws-token HTTP ${res.status}`);
          const body = (await res.json()) as { token: string; url: string };
          if (disposed) return;

          const socket = new WebSocket(`${body.url}?token=${encodeURIComponent(body.token)}`);
          currentSocket = socket;
          socketRef.current = socket;

          socket.onopen = () => {
            if (disposed) return;
            backoffMs = 500;
            setStatus("open");
            sendSubscribe(socket, "board");
            const extra = extraChannelRef.current;
            if (extra) sendSubscribe(socket, extra);
            reconnectHandler.current?.();
          };
          socket.onmessage = (event: MessageEvent<string>) => {
            if (disposed) return;
            try {
              const parsed = serverFrameSchema.safeParse(JSON.parse(event.data));
              if (!parsed.success) return;
              // ADR-0008: `board.batch` wraps ordinary frames — process each
              // with unchanged semantics.
              const frames: WsFrame[] =
                parsed.data.type === "board.batch" ? parsed.data.payload.frames : [parsed.data];
              for (const frame of frames) {
                const checked = wsFrameSchema.safeParse(frame);
                if (checked.success) frameHandler.current(checked.data);
              }
            } catch {
              // Malformed frame: ignore — next poll/REST refresh self-heals.
            }
          };
          socket.onclose = () => {
            if (disposed) return;
            setStatus("closed");
            retryTimer = setTimeout(connect, backoffMs);
            backoffMs = Math.min(backoffMs * 2, 10_000);
          };
          socket.onerror = () => {
            socket.close();
          };
        } catch {
          if (disposed) return;
          setStatus("closed");
          retryTimer = setTimeout(connect, backoffMs);
          backoffMs = Math.min(backoffMs * 2, 10_000);
        }
      })();
    };

    connect();

    // Mount-once: reconnect/backoff state lives in the closure; refs carry the
    // latest callbacks and the extra channel.
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      currentSocket?.close();
      socketRef.current = null;
    };
  }, []);

  // (Un)subscribe the extra channel on a live socket without reconnecting.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !extraChannel) return;
    socket.send(JSON.stringify({ action: "subscribe", channel: extraChannel }));
  }, [extraChannel]);

  return status;
}
