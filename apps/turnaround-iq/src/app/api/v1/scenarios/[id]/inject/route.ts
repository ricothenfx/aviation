import type { NextRequest } from "next/server";
import { z } from "zod";

import { ApiError } from "@aviation/contracts";
import { REFERENCE_SCENARIO_ID, disruptionById } from "@aviation/tiq-domain";

import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { withIdempotency } from "@/lib/api/idempotency";
import { injectDisruption } from "@/lib/data/scenarios";
import { getSingletonRedis } from "@/lib/redis-singleton";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ disruptionId: z.string().min(1) });

/**
 * POST /api/v1/scenarios/{id}/inject {disruptionId} (api-contracts.md §1, F3) —
 * supervisor only. Loads one of the scripted disruptions (loader breakdown,
 * gate swap, crew no-show) into the running scenario. 400 when no active
 * turnaround matches the script's target.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    return await withIdempotency(request, async () => {
      await requireSession("supervisor");
      const { id } = await context.params;
      if (id !== REFERENCE_SCENARIO_ID) {
        throw new ApiError("NOT_FOUND", `scenario ${id} not found`);
      }
      const body = bodySchema.parse(await request.json().catch(() => ({})));
      const definition = disruptionById(body.disruptionId);
      if (!definition) {
        throw new ApiError("VALIDATION_ERROR", `unknown disruption ${body.disruptionId}`);
      }
      const outcome = await injectDisruption(await getSingletonRedis(), id, definition.id);
      if (outcome.status !== "applied") {
        throw new ApiError(
          "VALIDATION_ERROR",
          "no active turnaround matches this disruption script right now",
        );
      }
      return jsonResponse(outcome);
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
