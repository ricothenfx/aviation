import { eventPayloadSchemas, type EventType } from "@aviation/contracts";
import type { RedisClientType } from "@aviation/db/redis";

import type { OrchestratorDb } from "../db";
import { claimEvents, markFailedAttempt, markProcessed } from "../domain/event-log";
import {
  handleFlightDisrupted,
  handleOfferConfirmed,
  type EngineMetrics,
} from "../domain/handlers";
import type { NotificationPublisher } from "../domain/notifications";

/**
 * Event-log tail (ADR-0014, D-11 poll pattern): claim unprocessed events in id
 * order, dispatch to domain handlers, mark processed. Failures consume one of
 * POISON_ATTEMPT_CAP attempts and record the error — exhausted events stay
 * processed=false with the note visible in the supervisor console
 * (architecture.md §6: never silently dropped).
 */

type Handler = (deps: TailDeps, payload: unknown) => Promise<void>;

export interface TailDeps {
  db: OrchestratorDb;
  redis: RedisClientType;
  publisher: NotificationPublisher;
  metrics: EngineMetrics;
  onLog: (msg: string, fields?: Record<string, unknown>) => void;
}

const HANDLERS: Partial<Record<EventType, Handler>> = {
  "flight.disrupted": (deps, payload) => handleFlightDisrupted(deps, payload),
  "offer.confirmed": (deps, payload) => handleOfferConfirmed(deps, payload),
};

export interface Tail {
  stop(): Promise<void>;
}

export function startEventTail(deps: TailDeps & { pollMs: number }): Tail {
  let running = true;
  // Reentrancy guard: a handler run that outlasts one poll interval must never
  // overlap the next tick — overlapping ticks would claim and process the same
  // unprocessed event twice (observed as duplicated offers in F2 smoke).
  let ticking = false;
  const timer: NodeJS.Timeout[] = [];

  async function tick(): Promise<void> {
    if (!running || ticking) return;
    ticking = true;
    try {
      const events = await claimEvents(deps.db, 25);
      for (const event of events) {
        try {
          const schema = (
            eventPayloadSchemas as Record<string, { parse: (p: unknown) => unknown }>
          )[event.type];
          if (!schema) {
            throw new Error(`unknown event type ${event.type}`);
          }
          const payload = schema.parse(event.payload);
          const handler = HANDLERS[event.type as EventType];
          if (handler) {
            await handler(deps, payload);
            deps.onLog("event_handled", { eventId: event.id, type: event.type });
          }
          // Events without a handler in this milestone (e.g. offer.created —
          // the disruption handler already did the writes) count as consumed.
          await markProcessed(deps.db, event.id);
          deps.metrics.counters["rb_orchestrator_events_processed_total"] =
            (deps.metrics.counters["rb_orchestrator_events_processed_total"] ?? 0) + 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await markFailedAttempt(deps.db, event.id, message);
          deps.onLog("event_handler_failed", {
            eventId: event.id,
            type: event.type,
            attempts: event.attempts + 1,
            err: message,
          });
          deps.metrics.counters["rb_orchestrator_event_failures_total"] =
            (deps.metrics.counters["rb_orchestrator_event_failures_total"] ?? 0) + 1;
        }
      }
    } catch (err) {
      deps.onLog("tail_tick_failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      ticking = false;
    }
  }

  const interval = setInterval(() => {
    void tick();
  }, deps.pollMs);
  timer.push(interval);

  return {
    async stop(): Promise<void> {
      running = false;
      clearInterval(interval);
    },
  };
}
