import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { buildPaxSummary } from "@/lib/data/views";
import { paxSummaryViewSchema } from "@aviation/contracts";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/pax/summary (rebook-ai api-contracts.md §1) — the current user's
 * disruption state, ownership-scoped to PNRs linked to the session user
 * (pnr.user_id, D-09). `disruption: null` stays the honest "no active
 * disruption" value (data-ethics.md §4). The response validates against the
 * F2 read-model contract before returning.
 */
export async function GET(): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    const session = await requireSession("passenger");
    const summary = paxSummaryViewSchema.parse(await buildPaxSummary(session));
    return jsonResponse(summary);
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
