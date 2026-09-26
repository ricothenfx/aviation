import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { getNotificationViews, getOwnedPnrs } from "@/lib/data/views";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/pax/notifications (rebook-ai api-contracts.md §1) — the
 * caller's inbox rows (SNS-shaped publisher, simulated delivery states).
 * Ownership-scoped via pnr.user_id.
 */
export async function GET(): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    const session = await requireSession("passenger");
    const owned = await getOwnedPnrs(session.sub);
    const notifications = await getNotificationViews(owned.map((o) => o.pnrId));
    return jsonResponse({ notifications });
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
