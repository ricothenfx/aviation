import type { NextRequest } from "next/server";
import { z } from "zod";

import { flightRowOrThrow } from "@/lib/data/flights";
import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { withIdempotency } from "@/lib/api/idempotency";
import { proposeReplan } from "@/lib/data/replans";
import { getSingletonDb } from "@/lib/db-singleton";
import { getSingletonRedis } from "@/lib/redis-singleton";

export const dynamic = "force-dynamic";

const uuidSchema = z.string().uuid();

/**
 * POST /api/v1/flights/{id}/replan (api-contracts.md §1, PRD F-4) — coordinator+.
 * Computes a proposal via the replan engine; does NOT apply it. Infeasible
 * inputs return 422 REPLAN_INFEASIBLE with the conflict list (api-contracts.md §2).
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    return await withIdempotency(request, async () => {
      await requireSession("coordinator");
      const { id } = await context.params;
      const flightId = uuidSchema.parse(id);
      await flightRowOrThrow(await getSingletonDb(), flightId);
      const replan = await proposeReplan(await getSingletonRedis(), flightId);
      return jsonResponse({ replan });
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
