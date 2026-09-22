import type { NextRequest } from "next/server";
import { z } from "zod";

import { REFERENCE_SCENARIO_ID } from "@aviation/tiq-domain";
import { ApiError } from "@aviation/contracts";

import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { startScenario } from "@/lib/data/scenarios";
import { getSingletonRedis } from "@/lib/redis-singleton";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ speed: z.union([z.literal(1), z.literal(5), z.literal(20)]) });

/**
 * POST /api/v1/scenarios/{id}/start {speed} (api-contracts.md §1) — supervisor
 * only. Idempotent: starting a running scenario restarts its clock from the day
 * start with the requested speed.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requireSession("supervisor");
    const { id } = await context.params;
    if (id !== REFERENCE_SCENARIO_ID) {
      throw new ApiError("NOT_FOUND", `scenario ${id} not found`);
    }
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const scenario = await startScenario(await getSingletonRedis(), id, body.speed);
    return jsonResponse({ scenario });
  } catch (err) {
    return handleRouteError(err);
  }
}
