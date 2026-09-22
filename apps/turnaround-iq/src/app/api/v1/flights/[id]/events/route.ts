import type { NextRequest } from "next/server";
import { z } from "zod";

import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { flightRowOrThrow, listFlightEvents } from "@/lib/data/flights";
import { getSingletonDb } from "@/lib/db-singleton";

export const dynamic = "force-dynamic";

const querySchema = z.object({ cursor: z.coerce.number().int().nonnegative().optional() });

/**
 * GET /api/v1/flights/{id}/events?cursor= (api-contracts.md §1) — audit replay,
 * cursor-paginated ascending (`Last-Event-Id` style). Viewer+.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requireSession("viewer");
    const { id } = await context.params;
    const flightId = z.string().uuid().parse(id);
    const db = getSingletonDb();
    await flightRowOrThrow(db, flightId);
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const page = await listFlightEvents(db, flightId, query.cursor ?? null);
    return jsonResponse(page);
  } catch (err) {
    return handleRouteError(err);
  }
}
