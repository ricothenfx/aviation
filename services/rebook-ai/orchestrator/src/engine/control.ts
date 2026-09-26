import type { RedisClientType } from "@aviation/db/redis";

import { REBOOK_CONTROL_CHANNEL } from "@aviation/contracts";

import { publishFrame, queueDeltaFrame } from "../domain/frames";
import { compensateSaga, type SagaDeps } from "../domain/saga";
import { requestProposalForOffer, type WorkerDeps } from "../domain/proposal-request";
import type { QueueProjector } from "../domain/queue";

/**
 * Control channel (architecture.md §1, ADR-0014/D-11 pattern): the web app
 * reaches the orchestrator through `chan:rb:control` commands + `rb:result:*`
 * reply keys — never via domain REST. Commands: `queue.rebuild` (F2),
 * `proposal.request` (F3 propose-only agent loop) and `saga.compensate`
 * (F3 supervisor manual compensation).
 */

export interface ControlRequest {
  id: string;
  type: string;
  replyTo?: string;
  proposalId?: string;
  pnrId?: string;
  offerId?: string;
  sagaId?: string;
}

export interface ControlSource {
  stop(): Promise<void>;
}

const RESULT_TTL_SECONDS = 30;

export function startControlListener(options: {
  redis: RedisClientType;
  projector: QueueProjector;
  sagaDeps: SagaDeps;
  gateway: WorkerDeps["gateway"];
  onLog: (msg: string, fields?: Record<string, unknown>) => void;
}): ControlSource {
  const { redis, projector, sagaDeps, gateway, onLog } = options;
  const workerDeps: WorkerDeps = { ...sagaDeps, gateway };

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
          } else if (request.type === "proposal.request") {
            if (!request.proposalId || !request.pnrId || !request.offerId) {
              throw new Error("proposal.request requires proposalId, pnrId and offerId");
            }
            await requestProposalForOffer(workerDeps, {
              proposalId: request.proposalId,
              pnrId: request.pnrId,
              offerId: request.offerId,
            });
            if (request.replyTo) {
              await redis.set(
                request.replyTo,
                JSON.stringify({ ok: true, proposalId: request.proposalId }),
                { EX: RESULT_TTL_SECONDS },
              );
            }
            onLog("control_proposal_created", {
              requestId: request.id,
              proposalId: request.proposalId,
            });
          } else if (request.type === "saga.compensate") {
            if (!request.sagaId) throw new Error("saga.compensate requires sagaId");
            const terminal = await compensateSaga(sagaDeps, request.sagaId, "supervisor-requested");
            if (request.replyTo) {
              await redis.set(request.replyTo, JSON.stringify({ ok: true, state: terminal }), {
                EX: RESULT_TTL_SECONDS,
              });
            }
            onLog("control_saga_compensated", {
              requestId: request.id,
              sagaId: request.sagaId,
              state: terminal,
            });
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
