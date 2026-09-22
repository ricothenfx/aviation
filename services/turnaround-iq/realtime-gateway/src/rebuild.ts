import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import type { Db } from "@aviation/db/client";
import {
  aircraftTypes,
  appliedEvents,
  events,
  flights,
  groundTasks,
  stands,
} from "@aviation/db/schema";
import type { DomainEvent } from "@aviation/contracts";
import { initialStateFromReferenceDay, type BoardProjectionState } from "@aviation/tiq-domain";

/**
 * Read-model rebuild inputs (architecture.md §4: Redis is a cache/projection
 * layer; rebuild = replay event_log). The planned baseline lives in PostgreSQL
 * (seed); the events carry the deltas. This module is gateway read-only — it
 * never mutates domain tables.
 */

export const GATEWAY_CONSUMER_ID = "realtime-gateway";

/** Load the planned baseline (stands/aircraft/flights/tasks) into projection state. */
export async function loadBaselineState(db: Db): Promise<BoardProjectionState> {
  const [standRows, typeRows, flightRows, taskRows] = await Promise.all([
    db.select().from(stands),
    db.select().from(aircraftTypes),
    db.select().from(flights).orderBy(asc(flights.schedInBlock)),
    db.select().from(groundTasks),
  ]);

  const standCodeById = new Map(standRows.map((s) => [s.id, s.code]));
  const typeCodeById = new Map(typeRows.map((t) => [t.id, t.code]));

  const tasksByFlight = new Map<string, typeof taskRows>();
  for (const task of taskRows) {
    const list = tasksByFlight.get(task.flightId);
    if (list) list.push(task);
    else tasksByFlight.set(task.flightId, [task]);
  }

  const state = initialStateFromReferenceDay({
    seed: 0,
    stands: [],
    aircraftTypes: [],
    dependencies: [],
    flights: flightRows.map((row) => {
      const taskList = (tasksByFlight.get(row.id) ?? []).slice();
      taskList.sort(
        (a, b) =>
          Date.parse(a.plannedStart.toISOString()) - Date.parse(b.plannedStart.toISOString()),
      );
      return {
        id: row.id,
        flightNo: row.flightNo,
        standId: row.standId,
        standCode: standCodeById.get(row.standId) ?? "?",
        aircraftTypeId: row.aircraftTypeId,
        aircraftTypeCode: typeCodeById.get(row.aircraftTypeId) ?? "?",
        schedInBlock: row.schedInBlock.toISOString(),
        schedOffBlock: row.schedOffBlock.toISOString(),
        delayedMin: 0,
        causeTaskType: null,
        tasks: taskList.map((task) => ({
          id: task.id,
          flightId: task.flightId,
          type: task.type,
          slaMinutes: task.slaMinutes,
          plannedStart: task.plannedStart.toISOString(),
          plannedEnd: task.plannedEnd.toISOString(),
          order: 0,
        })),
      };
    }),
  });
  // plannedOffBlockIso uses the pushback plannedEnd; with order stripped the
  // helper still finds the pushback task, so delayedMin stays correct via the
  // event replay that follows. Nothing else to compute here.
  return state;
}

export async function readEventsAfter(
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

export async function readAllEventsOrdered(db: Db): Promise<Array<DomainEvent & { seq: number }>> {
  const rows = await db.select().from(events).orderBy(asc(events.seq));
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

export async function maxEventSeq(db: Db): Promise<number> {
  const rows = await db
    .select({ max: sql<number>`coalesce(max(${events.seq}), 0)`.mapWith(Number) })
    .from(events);
  return rows[0]?.max ?? 0;
}

/** Persist consumer watermarks (data-model.md §2 `applied_events`). */
export async function saveWatermarks(db: Db, entries: ReadonlyMap<string, number>): Promise<void> {
  if (entries.size === 0) return;
  const values = [...entries.entries()].map(([aggregateId, lastSequence]) => ({
    consumerId: GATEWAY_CONSUMER_ID,
    aggregateId,
    lastSequence,
    updatedAt: new Date(),
  }));
  for (let i = 0; i < values.length; i += 200) {
    await db
      .insert(appliedEvents)
      .values(values.slice(i, i + 200))
      .onConflictDoUpdate({
        target: [appliedEvents.consumerId, appliedEvents.aggregateId],
        set: { lastSequence: sql`excluded.last_sequence`, updatedAt: sql`now()` },
      });
  }
}

export async function clearWatermarks(db: Db, aggregateIds?: string[]): Promise<void> {
  if (aggregateIds) {
    if (aggregateIds.length === 0) return;
    await db
      .delete(appliedEvents)
      .where(
        and(
          eq(appliedEvents.consumerId, GATEWAY_CONSUMER_ID),
          inArray(appliedEvents.aggregateId, aggregateIds),
        ),
      );
    return;
  }
  await db.delete(appliedEvents).where(eq(appliedEvents.consumerId, GATEWAY_CONSUMER_ID));
}
