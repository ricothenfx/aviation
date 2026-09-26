import { and, asc, eq, lt, sql } from "drizzle-orm";

import { eventPayloadSchemas, type EventPayloadMap, type EventType } from "@aviation/contracts";
import type { AggregateType } from "@aviation/contracts";

import type { OrchestratorDb } from "../db";
import { eventLog } from "../db";

/**
 * Event-log access for the orchestrator (engineering-standards.md §4,
 * ADR-0014: PostgreSQL is the queue of record). Producers validate payloads
 * against the typed schemas before append; the tail claims unprocessed events
 * in id order, and poison events keep processed=false with an error note
 * until the attempts cap — they surface in the supervisor console and are
 * never silently dropped (architecture.md §6).
 */

export const POISON_ATTEMPT_CAP = 3;

export interface AppendedEvent {
  id: string;
  sequence: number;
}

export async function appendEvent<T extends EventType>(
  db: OrchestratorDb,
  event: {
    type: T;
    aggregateType: AggregateType;
    aggregateId: string;
    payload: EventPayloadMap[T];
  },
): Promise<AppendedEvent> {
  // Producer-side payload validation (api-contracts.md §2): invalid payloads
  // never enter the log.
  const payload = eventPayloadSchemas[event.type].parse(event.payload);

  const [row] = await db
    .insert(eventLog)
    .values({
      type: event.type,
      occurredAt: new Date(),
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      // Monotonic per aggregate (engineering-standards.md §4); the unique
      // constraint is the race backstop for concurrent appenders.
      sequence: sql`(coalesce((select max(${eventLog.sequence}) from ${eventLog} where ${eventLog.aggregateId} = ${event.aggregateId}), 0) + 1)`,
      payload,
    })
    .returning({ id: eventLog.id, sequence: eventLog.sequence });
  if (!row) throw new Error(`event append returned no row for ${event.type}`);
  return { id: row.id, sequence: row.sequence };
}

/** Unprocessed events with retry budget left, oldest first (tail workset). */
export async function claimEvents(
  db: OrchestratorDb,
  limit: number,
): Promise<
  {
    id: string;
    type: string;
    aggregateType: string;
    aggregateId: string;
    payload: unknown;
    attempts: number;
  }[]
> {
  return db
    .select({
      id: eventLog.id,
      type: eventLog.type,
      aggregateType: eventLog.aggregateType,
      aggregateId: eventLog.aggregateId,
      payload: eventLog.payload,
      attempts: eventLog.attempts,
    })
    .from(eventLog)
    .where(and(eq(eventLog.processed, false), lt(eventLog.attempts, POISON_ATTEMPT_CAP)))
    .orderBy(asc(eventLog.id))
    .limit(limit);
}

export async function markProcessed(db: OrchestratorDb, id: string): Promise<void> {
  await db
    .update(eventLog)
    .set({ processed: true, processedAt: new Date(), processError: null })
    .where(eq(eventLog.id, id));
}

/** Records a failed attempt; at the cap the event stays unprocessed = poison. */
export async function markFailedAttempt(
  db: OrchestratorDb,
  id: string,
  error: string,
): Promise<void> {
  await db
    .update(eventLog)
    .set({
      attempts: sql`${eventLog.attempts} + 1`,
      processError: error.slice(0, 2000),
    })
    .where(eq(eventLog.id, id));
}
