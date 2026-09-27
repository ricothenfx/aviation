import type { NextRequest } from "next/server";

import { auditTrailViewSchema } from "@aviation/contracts";
import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { getAuditTrail } from "@/lib/data/views";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admin/audit (rebook-ai api-contracts.md §1, additive F4) —
 * supervisor view of the append-only decision trail (PRD F-7): who offered/
 * confirmed/approved what, for which booking, when. Read-only; rows come from
 * audit_events enriched with the actor email and the PNR locator.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    await requireSession("supervisor");
    const limitParam = Number(request.nextUrl.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
    const entries = await getAuditTrail(limit);
    return jsonResponse(auditTrailViewSchema.parse({ entries }));
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
