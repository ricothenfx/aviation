import { asc, sql } from "drizzle-orm";

import { engineUnits, rulPredictions } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { logger } from "@/lib/logger";
import { scoreFleetResponseSchema } from "@/lib/api/schemas";
import { AiInsufficientHistoryError, rulBackfill, rulScoreFleet } from "@/lib/ai/client";
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

  // Units that already had a prediction BEFORE this run — first-scoring
  // units get a trend backfill below (PRD F-5 "per-unit trend").
  const withPredictions = new Set(
    (await db.selectDistinct({ unitId: rulPredictions.unitId }).from(rulPredictions)).map(
      (r) => r.unitId,
    ),
  );

  const persisted = scoring.results.length > 0 ? await persistPredictions(scoring.results) : [];

  // First-scoring backfill: offline trend series at evenly spaced historical
  // checkpoints (one bulk round trip in the ai-service; no look-ahead — each
  // point's feature window stops AT its cycle). Provenance identical to the
  // live score.
  const backfilledCount = await backfillTrends(scoring, active, withPredictions, requestId);

  // Alert engine (architecture.md §2: rules are app-side product logic).
  const resultByUnit = new Map(scoring.results.map((r) => [r.unitId, r]));
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
  logger.info({ msg: "score_fleet_done", requestId, backfilledPoints: backfilledCount });
  return jsonResponse(body);
}

/** Trend checkpoints: up to 12 evenly spaced cycles from the earliest
 * scoreable point to the unit's latest cycle (latest included — upsert makes
 * it identical to the primary score). */
function trendCheckpoints(latestCycle: number): number[] {
  const earliest = MIN_TREND_CYCLES;
  if (latestCycle <= earliest) return [latestCycle];
  const points = 12;
  const step = (latestCycle - earliest) / (points - 1);
  const cycles = Array.from({ length: points }, (_, i) => Math.round(earliest + i * step)).filter(
    (c) => c >= earliest && c < latestCycle,
  );
  return [...new Set([...cycles, latestCycle])].sort((a, b) => a - b);
}

const MIN_TREND_CYCLES = 12;

async function backfillTrends(
  scoring: { modelVersion: string },
  active: Array<{ unitId: string; windowThresholdCycles: number; status: string }>,
  withPredictions: Set<string>,
  requestId: string,
): Promise<number> {
  const needing = active.filter((u) => !withPredictions.has(u.unitId));
  if (needing.length === 0) return 0;
  // Latest cycle per unit comes from the score just persisted.
  const latest = new Map(
    (
      await getSingletonDb()
        .select({ unitId: rulPredictions.unitId, cycle: rulPredictions.cycle })
        .from(rulPredictions)
    ).map((r) => [r.unitId, r.cycle]),
  );
  const entries = needing
    .map((u) => {
      const latestCycle = latest.get(u.unitId);
      return latestCycle ? { unitId: u.unitId, cycles: trendCheckpoints(latestCycle) } : null;
    })
    .filter((e): e is { unitId: string; cycles: number[] } => e !== null);
  if (entries.length === 0) return 0;

  const backfill = await rulBackfill(entries, requestId);
  if (backfill.results.length > 0) {
    await persistPredictions(backfill.results);
  }
  logger.info({
    msg: "score_fleet_backfilled",
    requestId,
    modelVersion: scoring.modelVersion,
    units: entries.length,
    points: backfill.results.length,
    skipped: backfill.skipped.length,
  });
  return backfill.results.length;
}

async function persistPredictions(
  results: Array<{
    unitId: string;
    cycle: number;
    rulCycles: number;
    bandLow: number;
    bandHigh: number;
    modelVersion: string;
    modelSha256: string;
  }>,
) {
  const db = getSingletonDb();
  return db
    .insert(rulPredictions)
    .values(
      results.map((r) => ({
        unitId: r.unitId,
        cycle: r.cycle,
        rulCycles: r.rulCycles,
        bandLow: r.bandLow,
        bandHigh: r.bandHigh,
        modelVersion: r.modelVersion,
        modelSha256: r.modelSha256,
      })),
    )
    .onConflictDoUpdate({
      target: [rulPredictions.unitId, rulPredictions.cycle],
      set: {
        rulCycles: sql`excluded.rul_cycles`,
        bandLow: sql`excluded.band_low`,
        bandHigh: sql`excluded.band_high`,
        modelVersion: sql`excluded.model_version`,
        modelSha256: sql`excluded.model_sha256`,
        createdAt: sql`now()`,
      },
    })
    .returning({ id: rulPredictions.id, unitId: rulPredictions.unitId });
}
