import { REFERENCE_SCENARIO_ID } from "@aviation/tiq-domain";
import { ApiError } from "@aviation/contracts";
import type { NextRequest } from "next/server";

import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { resetScenario } from "@/lib/data/scenarios";
import { getSingletonRedis } from "@/lib/redis-singleton";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/scenarios/{id}/reset (api-contracts.md §1) — stops the clock,
 * truncates projections + the event log, replays the seed; returns the fresh
 * `logHash` (PRD F-5 determinism). Supervisor only. The `Idempotency-Key` header
 * is accepted per engineering-standards.md §4; the operation is naturally
 * idempotent (N resets ⇒ the same deterministic empty-log hash).
 */
export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requireSession("supervisor");
    const { id } = await context.params;
    if (id !== REFERENCE_SCENARIO_ID) {
      throw new ApiError("NOT_FOUND", `scenario ${id} not found`);
    }
    const scenario = await resetScenario(await getSingletonRedis(), id);
    return jsonResponse({ scenario });
  } catch (err) {
    return handleRouteError(err);
  }
}
