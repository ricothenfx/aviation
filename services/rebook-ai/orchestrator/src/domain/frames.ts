import type { RedisClientType } from "@aviation/db/redis";

import {
  REBOOK_LIVE_CHANNEL,
  rebookLiveFrameSchema,
  type OffersUpdatePayload,
  type QueueDeltaPayload,
  type RebookLiveFrame,
  type SagaUpdatePayload,
} from "@aviation/contracts";

/**
 * Live frame fan-out on `chan:rb:live` (rebook-ai api-contracts.md §3,
 * architecture.md §4): validated envelopes, additive frame types only
 * (D-14 precedent). The web app bridges this channel to the browser via SSE
 * (`GET /api/v1/live`); clients resync from REST snapshots.
 */

export async function publishFrame(redis: RedisClientType, frame: RebookLiveFrame): Promise<void> {
  // Producer-side validation: frames never go out unvalidated.
  const validated = rebookLiveFrameSchema.parse(frame);
  await redis.publish(REBOOK_LIVE_CHANNEL, JSON.stringify(validated));
}

export function queueDeltaFrame(
  payload: QueueDeltaPayload,
  lastEventId: string | null,
): RebookLiveFrame {
  return rebookLiveFrameSchema.parse({
    id: `frame_${crypto.randomUUID()}`,
    ts: new Date().toISOString(),
    channel: REBOOK_LIVE_CHANNEL,
    type: "queue.delta",
    payload,
    lastEventId,
  });
}

export function offersUpdateFrame(
  payload: OffersUpdatePayload,
  lastEventId: string | null,
): RebookLiveFrame {
  return rebookLiveFrameSchema.parse({
    id: `frame_${crypto.randomUUID()}`,
    ts: new Date().toISOString(),
    channel: REBOOK_LIVE_CHANNEL,
    type: "offers.update",
    payload,
    lastEventId,
  });
}

export function sagaUpdateFrame(
  payload: SagaUpdatePayload,
  lastEventId: string | null,
): RebookLiveFrame {
  return rebookLiveFrameSchema.parse({
    id: `frame_${crypto.randomUUID()}`,
    ts: new Date().toISOString(),
    channel: REBOOK_LIVE_CHANNEL,
    type: "saga.update",
    payload,
    lastEventId,
  });
}
