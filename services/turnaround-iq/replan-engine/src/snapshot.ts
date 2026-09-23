import { asc, eq, inArray } from "drizzle-orm";

import type { Db } from "@aviation/db/client";
import { flights, groundTasks, taskDependencies } from "@aviation/db/schema";
import type { TaskStateChangedPayload } from "@aviation/contracts";
import {
  DISRUPTION_CATALOG,
  taskUnitKind,
  type TaskRuntimeState,
  type TurnPlanInput,
} from "@aviation/tiq-domain";

import { readAggregateEvents } from "./event-log";

/**
 * Snapshot builder (api-contracts.md §4 input contracts): rebuilds a turn's
 * plan + runtime state from the PostgreSQL baseline and the event log — the
 * source of truth for every engine decision (architecture.md §2: never Redis).
 *
 * Replay semantics (pure w.r.t. the log):
 * - latest `task.state_changed` per task wins (state, slaRemainingMin);
 * - `task.rescheduled` amends planned windows;
 * - a blocked event contributes the unit outage (blockedUntil) and, when it
 *   carries one, the stand curfew;
 * - `now` = the latest event instant of the flight — log-derived, never the
 *   wall clock, so the same log always yields the same plan (F3 determinism).
 */
export async function buildTurnInput(db: Db, flightId: string): Promise<TurnPlanInput | null> {
  const flightRows = await db.select().from(flights).where(eq(flights.id, flightId)).limit(1);
  const flight = flightRows[0];
  if (!flight) return null;

  const taskRows = await db
    .select()
    .from(groundTasks)
    .where(eq(groundTasks.flightId, flightId))
    .orderBy(asc(groundTasks.plannedStart));
  const depRows = taskRows.length
    ? await db
        .select()
        .from(taskDependencies)
        .where(
          inArray(
            taskDependencies.taskId,
            taskRows.map((task) => task.id),
          ),
        )
    : [];

  const events = await readAggregateEvents(db, [flightId, ...taskRows.map((task) => task.id)]);

  const plannedByTask = new Map(
    taskRows.map((task) => [
      task.id,
      {
        plannedStart: task.plannedStart.toISOString(),
        plannedEnd: task.plannedEnd.toISOString(),
      },
    ]),
  );
  const states = new Map<string, TaskRuntimeState>();
  const blockedByTask = new Map<string, TaskStateChangedPayload>();
  let standCurfew: string | null = null;
  let nowMs = Date.parse(flight.schedInBlock.toISOString());

  for (const event of events) {
    nowMs = Math.max(nowMs, Date.parse(event.occurredAt));
    if (event.type === "task.state_changed") {
      const payload = event.payload as TaskStateChangedPayload;
      if (payload.scenarioTs) nowMs = Math.max(nowMs, Date.parse(payload.scenarioTs));
      if (payload.state === "blocked") blockedByTask.set(payload.taskId, payload);
      if (payload.blockedUntil) {
        blockedByTask.set(payload.taskId, {
          ...payload,
          blockedUntil: payload.blockedUntil,
        });
      }
      if (payload.standCurfew) standCurfew = payload.standCurfew;
      states.set(payload.taskId, {
        state: payload.state,
        remainingMin: Math.max(0, payload.slaRemainingMin),
        blockedUntil: payload.blockedUntil ?? null,
      });
      continue;
    }
    if (event.type === "task.rescheduled") {
      const payload = event.payload as { taskId: string; newStart: string; newEnd: string };
      plannedByTask.set(payload.taskId, {
        plannedStart: payload.newStart,
        plannedEnd: payload.newEnd,
      });
      continue;
    }
  }

  // Blocked remaining work = slaRemainingMin − outage (recovery offset).
  for (const [taskId, blocked] of blockedByTask) {
    const state = states.get(taskId);
    if (!state || state.state !== "blocked") continue;
    if (blocked.blockedUntil) {
      const outageMin = Math.max(
        0,
        Math.round((Date.parse(blocked.blockedUntil) - Date.parse(blocked.scenarioTs)) / 60_000),
      );
      state.remainingMin = Math.max(0, state.remainingMin - outageMin);
    }
  }

  // In-progress tasks project their remaining work from the effective window.
  for (const [taskId, planned] of plannedByTask) {
    const state = states.get(taskId);
    if (!state || state.state !== "in_progress") continue;
    state.remainingMin = Math.max(0, Math.round((Date.parse(planned.plannedEnd) - nowMs) / 60_000));
  }

  const unavailableUnits = [...blockedByTask.values()]
    .filter((blocked) => states.get(blocked.taskId)?.state === "blocked")
    .map((blocked) => {
      const task = taskRows.find((row) => row.id === blocked.taskId);
      const kind = task ? taskUnitKind(task.type) : null;
      return {
        unitId: kind ? `${flight.flightNo}-${kind}` : blocked.taskId,
        kind: kind ?? "unknown",
        availableAt: blocked.blockedUntil ?? null,
      };
    });

  // Spare units come from the disruption catalog by knocked-out kind — the same
  // constant the simulator used, so engine and simulator always agree.
  const spareUnits: Record<string, number> = {};
  for (const unit of unavailableUnits) {
    const definition = DISRUPTION_CATALOG.find((entry) => entry.unitKind === unit.kind);
    spareUnits[unit.kind] = definition?.spareUnits ?? 0;
  }

  const statesWithDone = new Map(states);
  for (const task of taskRows) {
    if (!statesWithDone.has(task.id)) {
      // Never-started task: pending with its full planned duration to run.
      const planned = plannedByTask.get(task.id) as {
        plannedStart: string;
        plannedEnd: string;
      };
      statesWithDone.set(task.id, {
        state: "pending",
        remainingMin: Math.max(
          0,
          Math.round((Date.parse(planned.plannedEnd) - Date.parse(planned.plannedStart)) / 60_000),
        ),
        blockedUntil: null,
      });
    }
  }

  return {
    flightId: flight.id,
    flightNo: flight.flightNo,
    schedOffBlock: flight.schedOffBlock.toISOString(),
    planned: taskRows.map((task) => ({
      id: task.id,
      type: task.type,
      ...(plannedByTask.get(task.id) as { plannedStart: string; plannedEnd: string }),
    })),
    states: statesWithDone,
    dependencies: depRows.map((dep) => ({
      taskId: dep.taskId,
      predecessorTaskId: dep.predecessorTaskId,
    })),
    now: new Date(nowMs).toISOString(),
    unavailableUnits,
    spareUnits,
    standCurfew,
  };
}
