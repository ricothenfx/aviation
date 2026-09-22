import type { NextRequest } from "next/server";
import { z } from "zod";

import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { listEvents } from "@/lib/data/flights";
import { getSingletonDb } from "@/lib/db-singleton";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  aggregateId: z.string().uuid().optional(),
  after: z.coerce.number().int().nonnegative().optional(),
});

/**
 * GET /api/v1/events?aggregateId=&after= (api-contracts.md §1) — catch-up replay
 * for ws reconnects: strictly seq-ordered events after the last seen id. Viewer+.
 */
export async function GET(request: NextRequest) {
  try {
    await requireSession("viewer");
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const page = await listEvents(getSingletonDb(), {
      aggregateId: query.aggregateId,
      after: query.after ?? null,
    });
    return jsonResponse(page);
  } catch (err) {
    return handleRouteError(err);
  }
}
