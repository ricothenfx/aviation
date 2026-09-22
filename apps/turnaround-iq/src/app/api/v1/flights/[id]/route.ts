import { ApiError } from "@aviation/contracts";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { getFlightProjection } from "@/lib/data/board";
import { getFlightDetail } from "@/lib/data/flights";
import { getSingletonDb } from "@/lib/db-singleton";
import { getSingletonRedis } from "@/lib/redis-singleton";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/flights/{id} (api-contracts.md §1) — flight + tasks + alert
 * lifecycle for the drawer (ui-design-system.md §5.2). Viewer+.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requireSession("viewer");
    const { id } = await context.params;
    const flightId = z.string().uuid().parse(id);
    const db = getSingletonDb();
    const redis = await getSingletonRedis();
    const flight = await getFlightProjection(db, redis, flightId);
    if (!flight) {
      throw new ApiError("NOT_FOUND", `flight ${id} not found`);
    }
    return jsonResponse(await getFlightDetail(db, flight));
  } catch (err) {
    return handleRouteError(err);
  }
}
