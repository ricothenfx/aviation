import { eq } from "drizzle-orm";

import type { Db } from "@aviation/db/client";
import { alerts, flights, groundTasks, replanScenarios } from "@aviation/db/schema";
import type { FlightProjection } from "@aviation/contracts";

/**
 * PostgreSQL projection columns (data-model.md §2): `flights.status`,
 * `flights.est_off_block` and `ground_tasks.state` are maintained BY the event
 * handler — this module is the only writer (ADR-0001 compliance: no out-of-band
 * projection mutations). The live read model stays in Redis; PG keeps the
 * durable, replay-derivable copy.
 *
 * F3: `alerts` and `replan_scenarios` join the event-derived projections
 * (data-model.md §2: alert lifecycle derived from alert.* events; replan rows
 * from replan.* events), plus approved replans shift `ground_tasks.planned_*`.
 */
export async function persistProjectionToPg(db: Db, flight: FlightProjection): Promise<void> {
  await db
    .update(flights)
    .set({
      status: flight.status,
      estOffBlock: flight.estOffBlock ? new Date(flight.estOffBlock) : null,
    })
    .where(eq(flights.id, flight.id));

  for (const task of flight.tasks) {
    await db
      .update(groundTasks)
      .set({
        state: task.state,
        plannedStart: new Date(task.plannedStart),
        plannedEnd: new Date(task.plannedEnd),
      })
      .where(eq(groundTasks.id, task.id));
  }
}

type AlertLifecycleEvent = {
  type: "alert.raised" | "alert.acknowledged" | "alert.resolved";
  occurredAt: string;
  payload: {
    alertId: string;
    flightId: string;
    ruleId: string;
    severity: "info" | "warning" | "critical";
    leadTimeMin: number | null;
    note?: string;
  };
};

/** Upsert the alert lifecycle projection row (idempotent under replay). */
export async function persistAlertEventToPg(db: Db, event: AlertLifecycleEvent): Promise<void> {
  const raisedAt = new Date(event.occurredAt);
  const detail = {
    leadTimeMin: event.payload.leadTimeMin,
    ...(event.payload.note ? { note: event.payload.note } : {}),
  };
  if (event.type === "alert.raised") {
    await db
      .insert(alerts)
      .values({
        id: event.payload.alertId,
        flightId: event.payload.flightId,
        ruleId: event.payload.ruleId,
        severity: event.payload.severity,
        state: "raised",
        raisedAt,
        detail,
      })
      .onConflictDoUpdate({
        target: alerts.id,
        set: { state: "raised", raisedAt, detail },
      });
    return;
  }
  if (event.type === "alert.acknowledged") {
    await db
      .update(alerts)
      .set({ state: "acknowledged", acknowledgedAt: raisedAt })
      .where(eq(alerts.id, event.payload.alertId));
    return;
  }
  await db
    .update(alerts)
    .set({ state: "resolved", resolvedAt: raisedAt, detail })
    .where(eq(alerts.id, event.payload.alertId));
}

type ReplanLifecycleEvent = {
  type: "replan.proposed" | "replan.approved" | "replan.rejected";
  occurredAt: string;
  payload: {
    replanId: string;
    flightId: string;
    delta?: Array<{ taskId: string; newStart: string; newEnd: string }>;
    totalDelayMin?: number;
    baselineDelayMin?: number;
    planHash?: string;
  };
};

/** Upsert the replan projection row (data-model.md §2 replan_scenarios). */
export async function persistReplanEventToPg(db: Db, event: ReplanLifecycleEvent): Promise<void> {
  if (event.type === "replan.proposed") {
    await db
      .insert(replanScenarios)
      .values({
        id: event.payload.replanId,
        flightId: event.payload.flightId,
        proposalDiff: { delta: event.payload.delta ?? [] },
        status: "proposed",
        computedAt: new Date(event.occurredAt),
        costBreakdown: {
          totalDelayMin: event.payload.totalDelayMin ?? 0,
          baselineDelayMin: event.payload.baselineDelayMin ?? null,
          planHash: event.payload.planHash ?? null,
        },
      })
      .onConflictDoUpdate({
        target: replanScenarios.id,
        set: {
          proposalDiff: { delta: event.payload.delta ?? [] },
          status: "proposed",
          computedAt: new Date(event.occurredAt),
          costBreakdown: {
            totalDelayMin: event.payload.totalDelayMin ?? 0,
            baselineDelayMin: event.payload.baselineDelayMin ?? null,
            planHash: event.payload.planHash ?? null,
          },
        },
      });
    return;
  }
  await db
    .update(replanScenarios)
    .set({ status: event.type === "replan.approved" ? "approved" : "rejected" })
    .where(eq(replanScenarios.id, event.payload.replanId));
}
