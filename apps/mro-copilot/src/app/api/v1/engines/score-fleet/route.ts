import { asc } from "drizzle-orm";

import { engineUnits, rulPredictions } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { logger } from "@/lib/logger";
import { scoreFleetResponseSchema } from "@/lib/api/schemas";
import { AiInsufficientHistoryError, rulScoreFleet } from "@/lib/ai/client";
import {
  MroApiError,
  handleRouteError,
  jsonResponse,
  newRequestId,
  requireSession,
} from "@/lib/api/respond";
import { withIdempotency } from "@/lib/api/idempotency";
import { alertToApi, userNameMap } from "@/lib/engines/serialize";
import { evaluateAlert, openAlertFor, raiseAlert } from "@/lib/engines/alerts";

/**
 * POST /api/v1/engines/score-fleet (api-contracts.md §1, PRD FR-16/FR-18,
 * architecture.md §3 engine-health flow): engineer+ triggers synchronous
 * rescoring via ai-service → persists every prediction WITH provenance →
 * the app's alert engine compares projected RUL against each unit's
 * maintenance-window threshold → raises deduplicated alerts (append-only
 * audit). Short-history units are reported `insufficientHistory` — they get
 * NO prediction row, so the fleet view shows latestRul: null ("—").
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    await requireSession("engineer");
    return await withIdempotency(request, () => runScoreFleet(requestId));
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}

async function runScoreFleet(requestId: string) {
  const db = getSingletonDb();
  const started = Date.now();

  const units = await db.select().from(engineUnits).orderBy(asc(engineUnits.unitId));
  const active = units.filter((u) => u.status === "active");
  if (active.length === 0) {
    throw new MroApiError("VALIDATION_ERROR", "no active engine units to score");
  }

  const thresholdByUnit = new Map(active.map((u) => [u.unitId, u.windowThresholdCycles]));

  let scoring;
  try {
    scoring = await rulScoreFleet({ unitIds: active.map((u) => u.unitId) }, requestId);
  } catch (err) {
    if (err instanceof AiInsufficientHistoryError) {
      throw new MroApiError("AI_SERVICE_UNAVAILABLE", err.message);
    }
    throw err;
  }
  logger.info({
    msg: "score_fleet_scored",
    requestId,
    units: active.length,
    scored: scoring.results.length,
    insufficient: scoring.insufficientHistory.length,
    ms: Date.now() - started,
  });

  const resultByUnit = new Map(scoring.results.map((r) => [r.unitId, r]));
  const persisted = scoring.results.length > 0 ? await persistPredictions(scoring) : [];

  // Alert engine (architecture.md §2: rules are app-side product logic).
  const raisedAlerts = [];
  for (const unitId of scoring.results.map((r) => r.unitId)) {
    const prediction = resultByUnit.get(unitId)!;
    const threshold = thresholdByUnit.get(unitId)!;
    const open = await openAlertFor(unitId);
    const decision = evaluateAlert({
      predictedRul: prediction.rulCycles,
      threshold,
      openAlertExists: open !== null,
    });
    if (!decision.raise) continue;
    raisedAlerts.push(
      await raiseAlert({
        unitId,
        predictedRul: prediction.rulCycles,
        threshold,
        modelVersion: prediction.modelVersion,
        modelSha256: prediction.modelSha256,
      }),
    );
  }

  const names = await userNameMap();
  const body = scoreFleetResponseSchema.parse({
    modelVersion: scoring.modelVersion,
    modelSha256: scoring.modelSha256,
    scored: persisted.length,
    insufficientHistory: scoring.insufficientHistory,
    results: scoring.results,
    raisedAlerts: raisedAlerts.map((a) => alertToApi(a, names)),
  });
  return jsonResponse(body);
}

async function persistPredictions(scoring: {
  results: Array<{
    unitId: string;
    cycle: number;
    rulCycles: number;
    bandLow: number;
    bandHigh: number;
    modelVersion: string;
    modelSha256: string;
  }>;
}) {
  const db = getSingletonDb();
  return db
    .insert(rulPredictions)
    .values(
      scoring.results.map((r) => ({
        unitId: r.unitId,
        cycle: r.cycle,
        rulCycles: r.rulCycles,
        bandLow: r.bandLow,
        bandHigh: r.bandHigh,
        modelVersion: r.modelVersion,
        modelSha256: r.modelSha256,
      })),
    )
    .returning({ id: rulPredictions.id, unitId: rulPredictions.unitId });
}
