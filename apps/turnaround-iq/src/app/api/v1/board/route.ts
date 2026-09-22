import type { NextRequest } from "next/server";

import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { getBoardSnapshot } from "@/lib/data/board";
import { getSingletonDb } from "@/lib/db-singleton";
import { getSingletonRedis } from "@/lib/redis-singleton";

/**
 * GET /api/v1/board (api-contracts.md §1) — board snapshot: live projections from
 * Redis, planned-day fallback before a scenario runs. Viewer+ (PRD F-7).
 */
export async function GET(_request: NextRequest) {
  try {
    await requireSession("viewer");
    const snapshot = await getBoardSnapshot(getSingletonDb(), await getSingletonRedis());
    return jsonResponse(snapshot);
  } catch (err) {
    return handleRouteError(err);
  }
}
