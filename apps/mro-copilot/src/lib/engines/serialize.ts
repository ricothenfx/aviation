import { users, type EngineAlertRow } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import type { EngineAlert } from "@/lib/api/schemas";

/**
 * Shared serialization for engine alerts (api-contracts.md §1 alert shape).
 * Provenance is mandatory: alerts carry RUL numbers, therefore modelVersion +
 * modelSha256 (api-contracts.md §4 behavioral contract).
 */
export function alertToApi(row: EngineAlertRow, userNames: Map<string, string>): EngineAlert {
  return {
    alertId: row.id,
    unitId: row.unitId,
    state: row.state,
    projectedRul: row.projectedRul,
    threshold: row.threshold,
    leadCycles: row.leadCycles,
    modelVersion: row.modelVersion,
    modelSha256: row.modelSha256,
    raisedAt: row.raisedAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    acknowledgedByName: row.acknowledgedBy ? (userNames.get(row.acknowledgedBy) ?? null) : null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedByName: row.resolvedBy ? (userNames.get(row.resolvedBy) ?? null) : null,
    resolveNote: row.resolveNote,
  };
}

/** id → displayName for actor attribution on alerts. */
export async function userNameMap(): Promise<Map<string, string>> {
  const db = getSingletonDb();
  const rows = await db.select({ id: users.id, name: users.displayName }).from(users);
  return new Map(rows.map((r) => [r.id, r.name]));
}
