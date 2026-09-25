import { and, eq, inArray } from "drizzle-orm";

import { engineAlerts, type EngineAlertRow } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { recordAudit } from "@/lib/audit";

/**
 * Maintenance-window alert rules (PRD FR-17/FR-18, architecture.md §2: the
 * alert engine lives in the TS app; ai-service only scores units).
 *
 * Rule: a unit whose predicted RUL is at or below its maintenance-window
 * threshold gets an alert — ONE open alert per unit (raised | acknowledged);
 * a resolved alert may be superseded by a new raise on a later crossing.
 *
 * leadCycles = predicted remaining cycles at raise, i.e. the lead time the
 * alert provides before the projected removal. Fixtures guarantee ≥ 5
 * (FR-18); the dashboard never fabricates a lead for deep-window units.
 */

export const OPEN_ALERT_STATES = ["raised", "acknowledged"] as const;

export interface AlertDecision {
  raise: boolean;
  leadCycles: number;
  reason: "below_threshold" | "already_open" | "above_threshold";
}

export function evaluateAlert(input: {
  predictedRul: number;
  threshold: number;
  openAlertExists: boolean;
}): AlertDecision {
  if (input.predictedRul > input.threshold) {
    return { raise: false, leadCycles: input.predictedRul, reason: "above_threshold" };
  }
  if (input.openAlertExists) {
    return { raise: false, leadCycles: input.predictedRul, reason: "already_open" };
  }
  return { raise: true, leadCycles: input.predictedRul, reason: "below_threshold" };
}

export async function openAlertFor(unitId: string): Promise<EngineAlertRow | null> {
  const db = getSingletonDb();
  const rows = await db
    .select()
    .from(engineAlerts)
    .where(
      and(eq(engineAlerts.unitId, unitId), inArray(engineAlerts.state, [...OPEN_ALERT_STATES])),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Raise + audit in one place so score-fleet and future flows share rules. */
export async function raiseAlert(input: {
  unitId: string;
  predictedRul: number;
  threshold: number;
  modelVersion: string;
  modelSha256: string;
}): Promise<EngineAlertRow> {
  const db = getSingletonDb();
  const [row] = await db
    .insert(engineAlerts)
    .values({
      unitId: input.unitId,
      state: "raised",
      projectedRul: input.predictedRul,
      threshold: input.threshold,
      leadCycles: input.predictedRul,
      modelVersion: input.modelVersion,
      modelSha256: input.modelSha256,
    })
    .returning();
  await recordAudit({
    eventType: "alert.raised",
    alertId: row!.id,
    actorId: null,
    payload: {
      unitId: input.unitId,
      projectedRul: input.predictedRul,
      threshold: input.threshold,
      leadCycles: input.predictedRul,
      modelVersion: input.modelVersion,
      modelSha256: input.modelSha256,
    },
  });
  return row!;
}
