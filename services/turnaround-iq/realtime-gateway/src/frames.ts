import type { DomainEvent, WsBatchFrame, WsFrame, EventType } from "@aviation/contracts";

/**
 * Pure ws frame plumbing (api-contracts.md §3): build envelope frames per event,
 * plus the outbound queue implementing architecture.md §6 — per-client batching
 * at ≤ 10 Hz with drop-oldest backpressure (the REST catch-up path remains the
 * recovery mechanism, so dropped deltas are never lost, only deferred).
 *
 * Channel namespace note: ws subscription channels are client-facing names
 * (`board`, `flight:{id}`) per api-contracts.md §3; the Redis pub/sub channels
 * (`chan:*`, data-model.md §3) are internal transport and never leak into frames.
 */

export const WS_CHANNEL_BOARD = "board";
export const wsChanFlight = (flightId: string): string => `flight:${flightId}`;

let frameCounter = 0;

export function buildEventFrame(event: DomainEvent, channel: string, ts: string): WsFrame {
  frameCounter += 1;
  return {
    id: `f:${frameCounter}`,
    ts,
    channel,
    type: event.type,
    payload: event.payload,
    lastEventId: event.id,
  };
}

/** Frames for one applied event: its flight channel + the board channel. */
export function framesForEvent(
  event: DomainEvent & { payload: { flightId?: string } },
  ts: string,
): WsFrame[] {
  const frames: WsFrame[] = [buildEventFrame(event, WS_CHANNEL_BOARD, ts)];
  if (event.payload.flightId) {
    frames.push(buildEventFrame(event, wsChanFlight(event.payload.flightId), ts));
  }
  return frames;
}

export function buildKpiFrame(kpis: unknown, lastEventId: string | null, ts: string): WsFrame {
  frameCounter += 1;
  return {
    id: `f:${frameCounter}`,
    ts,
    channel: WS_CHANNEL_BOARD,
    type: "kpi.updated" satisfies EventType,
    payload: kpis,
    lastEventId,
  };
}

export function buildTickFrame(scenarioTs: string, speed: 1 | 5 | 20, ts: string): WsFrame {
  frameCounter += 1;
  return {
    id: `f:${frameCounter}`,
    ts,
    channel: WS_CHANNEL_BOARD,
    type: "scenario.tick" satisfies EventType,
    payload: { scenarioTs, speed },
    lastEventId: null,
  };
}

/**
 * Wire-only batch envelope (ADR-0008): one socket write per client flush
 * instead of one per frame. Inner frames are ordinary WsFrames — per-frame
 * causality and latency semantics unchanged.
 */
export function buildBatchFrame(frames: WsFrame[], ts: string): WsBatchFrame {
  frameCounter += 1;
  return {
    id: `f:${frameCounter}`,
    ts,
    channel: WS_CHANNEL_BOARD,
    type: "board.batch",
    payload: { frames },
    lastEventId: null,
  };
}

/** Frame types whose older copies are superseded when a newer one is queued —
 * pure state snapshots. Event-history frames (turn/task/alert/replan) are never
 * merged away: every delivery matters to the audit feed. */
const COALESCIBLE_TYPES = new Set<string>(["kpi.updated", "scenario.tick", "flight.delay_risk"]);

/** Keeps the newest frame per (channel, coalescible type), preserving order. */
export function coalesceFrames(pending: readonly WsFrame[]): WsFrame[] {
  const lastIndexByType = new Map<string, number>();
  pending.forEach((frame, index) => {
    if (COALESCIBLE_TYPES.has(frame.type)) {
      lastIndexByType.set(`${frame.channel}|${frame.type}`, index);
    }
  });
  if (lastIndexByType.size === 0) return [...pending];
  return pending.filter((frame, index) => {
    if (!COALESCIBLE_TYPES.has(frame.type)) return true;
    return lastIndexByType.get(`${frame.channel}|${frame.type}`) === index;
  });
}

/**
 * Per-client outbound queue: bounded (drop-oldest under backpressure) with a
 * dedupe pass at flush time. Flush cadence (100 ms ⇒ ≤ 10 Hz) is the caller's.
 */
export class OutboundQueue {
  private pending: WsFrame[] = [];

  constructor(
    private readonly capacity: number = 500,
    private readonly maxFramesPerFlush: number = 100,
  ) {}

  push(frame: WsFrame): void {
    this.pending.push(frame);
    if (this.pending.length > this.capacity) {
      // Backpressure (architecture.md §6): drop the oldest deltas; clients catch
      // up via /api/v1/events?after=lastEventId (api-contracts.md §3).
      this.pending = this.pending.slice(this.pending.length - this.capacity);
    }
  }

  flush(): WsFrame[] {
    if (this.pending.length === 0) return [];
    const coalesced = coalesceFrames(this.pending);
    const batch = coalesced.slice(0, this.maxFramesPerFlush);
    this.pending = coalesced.slice(batch.length);
    return batch;
  }

  size(): number {
    return this.pending.length;
  }
}
