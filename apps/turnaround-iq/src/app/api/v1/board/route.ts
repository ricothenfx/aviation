import type { NextRequest } from "next/server";

import { boardSnapshotSchema } from "@aviation/contracts";

import { errorResponse, handleRouteError, jsonResponse } from "@/lib/api/respond";
import { getSession } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/rbac";

/**
 * GET /api/v1/board (api-contracts.md §1) — board snapshot, REST fallback when WS is down.
 * F1 scaffold: authenticated + RBAC-checked envelope with empty collections.
 * F2 replaces the body with real projections (additive schema extension in packages/contracts).
 */
export async function GET(_request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return errorResponse("UNAUTHENTICATED", "sign in required");
    }
    if (!roleAtLeast(session.role, "viewer")) {
      return errorResponse("FORBIDDEN", "viewer role required");
    }

    const snapshot = boardSnapshotSchema.parse({
      generatedAt: new Date().toISOString(),
      scenarioTs: null,
      live: false,
      flights: [],
      kpis: null,
    });
    return jsonResponse(snapshot);
  } catch (err) {
    return handleRouteError(err);
  }
}
