import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { getOwnedPnrs, getVoucherViews } from "@/lib/data/views";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/pax/vouchers (rebook-ai api-contracts.md §1) — the caller's own
 * vouchers with full criteria (explainable, PRD F-3). Ownership-scoped via
 * pnr.user_id.
 */
export async function GET(): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    const session = await requireSession("passenger");
    const owned = await getOwnedPnrs(session.sub);
    const vouchers = await getVoucherViews(owned.map((o) => o.pnrId));
    return jsonResponse({ vouchers });
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
