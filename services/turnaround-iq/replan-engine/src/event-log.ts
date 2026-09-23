import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import type { Db } from "@aviation/db/client";
import { events } from "@aviation/db/schema";
import type { DomainEvent, EventPayloadMap, EventType } from "@aviation/contracts";
import type { AggregateType, EventProducer } from "@aviation/db/schema";

/**
 * Engine-side event-log access (ADR-0001): append-only writes with per-aggregate
 * sequence assignment + retry (the simulator appends task events concurrently —
 * the unique (aggregate_id, sequence) index is the arbiter), plus the read
 * helpers the risk daemon and snapshot builder need.
 */

export async function maxSeq(db: Db): Promise<number> {
  const rows = await db
    .select({ max: sql<number>`coalesce(max(${events.seq}), 0)`.mapWith(Number) })
    .from(events);
  return rows[0]?.max ?? 0;
}

export async function readEventsAfterSeq(
  db: Db,
  afterSeq: number,
  limit: number,
): Promise<Array<DomainEvent & { seq: number }>> {
  const rows = await db
    .select()
    .from(events)
    .where(gt(events.seq, afterSeq))
    .orderBy(asc(events.seq))
    .limit(limit);
  return rows.map(toDomainEvent);
}

/** All events of the given aggregates in log order (snapshot replay input). */
export async function readAggregateEvents(
  db: Db,
  aggregateIds: readonly string[],
): Promise<Array<DomainEvent & { seq: number }>> {
  if (aggregateIds.length === 0) return [];
  const rows = await db
    .select()
    .from(events)
    .where(inArray(events.aggregateId, [...aggregateIds]))
    .orderBy(asc(events.seq));
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

async function nextSequence(db: Db, aggregateId: string): Promise<number> {
  const rows = await db
    .select({ max: sql<number>`coalesce(max(${events.sequence}), 0)`.mapWith(Number) })
    .from(events)
    .where(eq(events.aggregateId, aggregateId));
  return (rows[0]?.max ?? 0) + 1;
}

/**
 * Append one engine/user event with retry: a concurrent simulator append for the
 * same task aggregate can claim the sequence between read and insert; the unique
 * index rejects, we re-read and retry (bounded).
 */
export async function appendEvent<K extends EventType>(args: {
  db: Db;
  type: K;
  aggregateId: string;
  aggregateType: AggregateType;
  occurredAt: string;
  payload: EventPayloadMap[K];
  producer: EventProducer;
}): Promise<(DomainEvent & { type: K; payload: EventPayloadMap[K] }) | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const sequence = await nextSequence(args.db, args.aggregateId);
    const event = {
      id: `evt:${args.aggregateType}:${args.aggregateId}:${sequence}`,
      type: args.type,
      occurredAt: args.occurredAt,
      aggregateId: args.aggregateId,
      aggregateType: args.aggregateType,
      sequence,
      payload: args.payload,
    } as DomainEvent & { type: K; payload: EventPayloadMap[K] };
    const inserted = await args.db
      .insert(events)
      .values({
        id: event.id,
        aggregateId: event.aggregateId,
        aggregateType: event.aggregateType,
        type: event.type,
        sequence: event.sequence,
        occurredAt: new Date(event.occurredAt),
        payload: event.payload,
        producer: args.producer,
      })
      .onConflictDoNothing()
      .returning({ seq: events.seq });
    if (inserted.length > 0) return event;
  }
  return null;
}

/** Guard for user-action endpoints: the aggregate must exist and be untouched. */
export async function aggregateExists(db: Db, aggregateId: string): Promise<boolean> {
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.aggregateId, aggregateId), eq(events.sequence, 1)))
    .limit(1);
  return rows.length > 0;
}
