import { and, eq, gt, sql } from "drizzle-orm";

import type { Db } from "@aviation/db/client";
import { events } from "@aviation/db/schema";
import type { DomainEvent, TurnaroundAggregateType } from "@aviation/contracts";

/**
 * Event-log access for the simulator (ADR-0001): append-only writes with the
 * (aggregate_id, sequence) unique index as the idempotency key. There is no
 * update and no delete — except the explicit scenario-reset truncation, which is
 * an operator action behind the supervisor-only REST endpoint (api-contracts.md
 * §1 POST /scenarios/{id}/reset).
 */

/**
 * Append events; duplicates (same aggregate + sequence) are silently skipped and
 * counted as no-ops. Returns the number of rows actually persisted.
 */
export async function appendEvents(db: Db, batch: readonly DomainEvent[]): Promise<number> {
  if (batch.length === 0) return 0;
  const inserted = await db
    .insert(events)
    .values(
      batch.map((event) => ({
        id: event.id,
        aggregateId: event.aggregateId,
        // Turnaround aggregate enum — rebook-ai's additive aggregates never
        // enter this event log (D-11/D-14); its own log arrives with rebook F2.
        aggregateType: event.aggregateType as TurnaroundAggregateType,
        type: event.type,
        sequence: event.sequence,
        occurredAt: new Date(event.occurredAt),
        payload: event.payload,
        producer: "simulator" as const,
      })),
    )
    .onConflictDoNothing()
    .returning({ seq: events.seq });
  return inserted.length;
}

/** Durable per-aggregate watermarks (max sequence) — restart resume state. */
export async function loadWatermarks(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({
      aggregateId: events.aggregateId,
      last: sql<number>`max(${events.sequence})`.mapWith(Number),
    })
    .from(events)
    .groupBy(events.aggregateId);
  return new Map(rows.map((row) => [row.aggregateId, row.last]));
}

/** Events after a log position, optionally filtered by type (tail polling). */
export async function readEventsAfterSeq(
  db: Db,
  afterSeq: number,
  limit: number,
  type?: string,
): Promise<Array<DomainEvent & { seq: number }>> {
  const conditions = [];
  if (type) conditions.push(eq(events.type, type));
  conditions.push(gt(events.seq, afterSeq));
  const rows = await db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(events.seq)
    .limit(limit);
  return rows.map(toDomainEvent);
}

function toDomainEvent(row: typeof events.$inferSelect): DomainEvent & { seq: number } {
  return {
    seq: Number(row.seq),
    id: row.id,
    type: row.type as DomainEvent["type"],
    occurredAt: row.occurredAt.toISOString(),
    aggregateId: row.aggregateId,
    aggregateType: row.aggregateType,
    sequence: row.sequence,
    payload: row.payload,
  };
}

/** Full log in seq order — the replay source of truth (architecture.md §4). */
export async function readAllEvents(db: Db): Promise<Array<DomainEvent & { seq: number }>> {
  const rows = await db.select().from(events).orderBy(events.seq);
  return rows.map((row) => ({
    seq: Number(row.seq),
    id: row.id,
    type: row.type as DomainEvent["type"],
    occurredAt: row.occurredAt.toISOString(),
    aggregateId: row.aggregateId,
    aggregateType: row.aggregateType,
    sequence: row.sequence,
    payload: row.payload,
  }));
}

/** Scenario reset: truncates the log + watermarks; seq numbering restarts. */
export async function truncateEventLog(db: Db): Promise<void> {
  await db.execute(sql`truncate table ${events} restart identity`);
}

/**
 * Scenario reset also rewinds the PG projection columns (data-model.md §2) to
 * their seeded defaults. Alerts + replan_scenarios are event-derived projections
 * too (F3), so they truncate with the log. This is an operator action behind the
 * supervisor-only reset endpoint — runtime projection writes stay inside the
 * event handler (ADR-0001).
 */
export async function resetProjectionColumns(db: Db): Promise<void> {
  await db.execute(sql`update flights set status = 'scheduled', est_off_block = null`);
  await db.execute(sql`update ground_tasks set state = 'pending'`);
  await db.execute(sql`truncate table alerts`);
  await db.execute(sql`truncate table replan_scenarios`);
}
