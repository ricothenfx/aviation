import type { RedisClientType } from "@aviation/db/redis";

import { REBOOK_CONTROL_CHANNEL } from "@aviation/contracts";

import { publishFrame, queueDeltaFrame } from "../domain/frames";
import type { QueueProjector } from "../domain/queue";

/**
 * Control channel (architecture.md §1, ADR-0014/D-11 pattern): the web app
 * reaches the orchestrator through `chan:rb:control` commands + `rb:result:*`
 * reply keys — never via domain REST. F2 commands: `queue.rebuild` (the
 * queue endpoint rebuilds the projection after a Redis flush).
 */

export interface ControlRequest {
  id: string;
  type: string;
  replyTo?: string;
}

export interface ControlSource {
  stop(): Promise<void>;
}

const RESULT_TTL_SECONDS = 15;

export function startControlListener(options: {
  redis: RedisClientType;
  projector: QueueProjector;
  onLog: (msg: string, fields?: Record<string, unknown>) => void;
}): ControlSource {
  const { redis, projector, onLog } = options;

  const subscriber = redis.duplicate();
  void subscriber.connect().then(() =>
    subscriber.subscribe(REBOOK_CONTROL_CHANNEL, (raw) => {
      void (async () => {
        let request: ControlRequest;
        try {
          request = JSON.parse(raw) as ControlRequest;
        } catch {
          onLog("control_ignored_unparseable", {});
          return;
        }
        try {
          if (request.type === "queue.rebuild") {
            const delta = await projector.rebuild();
            await publishFrame(redis, queueDeltaFrame({ ...delta, reason: "rebuild" }, null));
            if (request.replyTo) {
              await redis.set(
                request.replyTo,
                JSON.stringify({
                  ok: true,
                  waiting: delta.waiting,
                  containmentPct: delta.containmentPct,
                }),
                { EX: RESULT_TTL_SECONDS },
              );
            }
            onLog("control_queue_rebuilt", { requestId: request.id });
          } else {
            if (request.replyTo) {
              await redis.set(
                request.replyTo,
                JSON.stringify({ ok: false, error: "unknown_command" }),
                {
                  EX: RESULT_TTL_SECONDS,
                },
              );
            }
            onLog("control_unknown_command", { requestId: request.id, type: request.type });
          }
        } catch (err) {
          onLog("control_failed", {
            requestId: request.id,
            type: request.type,
            err: err instanceof Error ? err.message : String(err),
          });
          if (request.replyTo) {
            await redis
              .set(
                request.replyTo,
                JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "failed" }),
                { EX: RESULT_TTL_SECONDS },
              )
              .catch(() => undefined);
          }
        }
      })();
    }),
  );

  return {
    async stop(): Promise<void> {
      await subscriber.quit().catch(() => undefined);
    },
  };
}
