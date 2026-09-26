import { REBOOK_CONTROL_CHANNEL } from "@aviation/contracts";

import { getRedisPublisher } from "@/lib/data/queue";

/**
 * Web → orchestrator command over `chan:rb:control` + `rb:result:{id}` reply
 * keys (architecture.md §1/§4, ADR-0014/D-11 pattern — the browser never
 * talks to the orchestrator directly). F2 shipped `queue.rebuild`; F3 adds
 * `proposal.request` and `saga.compensate` (api-contracts.md §1).
 */

export type ControlResult<T> =
  { kind: "ok"; result: T } | { kind: "error"; message: string } | { kind: "timeout" };

export async function requestOrchestrator<T = Record<string, unknown>>(
  type: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 8_000,
): Promise<ControlResult<T>> {
  const redis = await getRedisPublisher();
  const requestId = crypto.randomUUID();
  const replyTo = `rb:result:${requestId}`;
  await redis.publish(
    REBOOK_CONTROL_CHANNEL,
    JSON.stringify({ id: requestId, type, replyTo, ...payload }),
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await redis.get(replyTo);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as { ok?: boolean; error?: string };
        if (parsed.ok === false) {
          return { kind: "error", message: parsed.error ?? "orchestrator command failed" };
        }
        return { kind: "ok", result: parsed as T };
      } catch {
        return { kind: "error", message: "unparseable orchestrator result" };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { kind: "timeout" };
}
