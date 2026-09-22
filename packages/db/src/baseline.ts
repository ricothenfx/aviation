import { sql } from "drizzle-orm";

import type { Db } from "./client";
import { aircraftTypes, flights, groundTasks, stands, taskDependencies } from "./schema";

/**
 * Reference-day baseline upserts (engineering-standards.md §8: seed data is the
 * single source for demos and tests). Persistence plumbing for the turnaround-iq
 * schema — the deterministic fixture itself lives in the project domain package
 * (services/turnaround-iq/domain). Idempotent by deterministic UUID keys; safe to
 * run from the seed script, the simulator, and integration tests.
 */

/** Structural shape (kept free of service-package imports, D-08). */
export interface BaselineReferenceDay {
  stands: Array<{
    id: string;
    code: string;
    standType: "narrow" | "wide";
    constraints: Record<string, unknown>;
  }>;
  aircraftTypes: Array<{ id: string; code: string; turnSlaDefaults: unknown }>;
  flights: Array<{
    id: string;
    flightNo: string;
    standId: string;
    aircraftTypeId: string;
    schedInBlock: string | Date;
    schedOffBlock: string | Date;
    tasks: Array<{
      id: string;
      flightId: string;
      type: string;
      slaMinutes: number;
      plannedStart: string | Date;
      plannedEnd: string | Date;
    }>;
  }>;
  dependencies: Array<{ taskId: string; predecessorTaskId: string }>;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function excluded(column: string) {
  return sql.raw(`excluded."${column}"`);
}

const asDate = (value: string | Date): Date => (value instanceof Date ? value : new Date(value));

export async function upsertReferenceDay(db: Db, day: BaselineReferenceDay): Promise<void> {
  for (const batch of chunk(day.stands, 100)) {
    await db
      .insert(stands)
      .values(batch)
      .onConflictDoUpdate({
        target: stands.id,
        set: {
          code: excluded("code"),
          standType: excluded("stand_type"),
          constraints: excluded("constraints"),
        },
      });
  }

  for (const batch of chunk(day.aircraftTypes, 100)) {
    await db
      .insert(aircraftTypes)
      .values(batch)
      .onConflictDoUpdate({
        target: aircraftTypes.id,
        set: { code: excluded("code"), turnSlaDefaults: excluded("turn_sla_defaults") },
      });
  }

  for (const batch of chunk(
    day.flights.map((flight) => ({
      id: flight.id,
      flightNo: flight.flightNo,
      standId: flight.standId,
      aircraftTypeId: flight.aircraftTypeId,
      schedInBlock: asDate(flight.schedInBlock),
      schedOffBlock: asDate(flight.schedOffBlock),
      estOffBlock: null,
      status: "scheduled" as const,
    })),
    100,
  )) {
    await db
      .insert(flights)
      .values(batch)
      .onConflictDoUpdate({
        target: flights.id,
        set: {
          flightNo: excluded("flight_no"),
          standId: excluded("stand_id"),
          aircraftTypeId: excluded("aircraft_type_id"),
          schedInBlock: excluded("sched_in_block"),
          schedOffBlock: excluded("sched_off_block"),
          // est_off_block + status are projection columns — only event replay
          // writes them (ADR-0001).
        },
      });
  }

  const taskRows = day.flights.flatMap((flight) =>
    flight.tasks.map((task) => ({
      id: task.id,
      flightId: task.flightId,
      type: task.type,
      slaMinutes: task.slaMinutes,
      plannedStart: asDate(task.plannedStart),
      plannedEnd: asDate(task.plannedEnd),
      state: "pending" as const,
      config: {},
    })),
  );
  for (const batch of chunk(taskRows, 200)) {
    await db
      .insert(groundTasks)
      .values(batch)
      .onConflictDoUpdate({
        target: groundTasks.id,
        set: {
          type: excluded("type"),
          slaMinutes: excluded("sla_minutes"),
          plannedStart: excluded("planned_start"),
          plannedEnd: excluded("planned_end"),
          // `state` is a projection column — only event replay writes it.
        },
      });
  }

  for (const batch of chunk(day.dependencies, 500)) {
    await db.insert(taskDependencies).values(batch).onConflictDoNothing();
  }
}
