import type { NextRequest } from "next/server";

import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { getOfferSetView } from "@/lib/data/views";
import { getSingletonDb } from "@/lib/db-singleton";
import { offers, pnr } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/pax/offers/{offerId} (rebook-ai api-contracts.md §1) — one offer
 * set + ranked options + per-rank reasons. 404 unless the offer belongs to the
 * caller's PNR (passenger) or the caller is agent/supervisor (ownership
 * scoping, architecture.md §5; RBAC matrix DoD).
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ offerId: string }> },
): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    const session = await requireSession("passenger");
    const { offerId } = await context.params;

    const db = getSingletonDb();
    const [row] = await db
      .select({ ownerUserId: pnr.userId })
      .from(offers)
      .innerJoin(pnr, eq(offers.pnrId, pnr.id))
      .where(eq(offers.id, offerId))
      .limit(1);

    const isOwner = row?.ownerUserId !== null && row?.ownerUserId === session.sub;
    if (!row || (!isOwner && session.role === "passenger")) {
      return jsonResponse(
        { error: { code: "NOT_FOUND", message: "offer not found", requestId } },
        404,
      );
    }

    const offer = await getOfferSetView(offerId);
    if (!offer) {
      return jsonResponse(
        { error: { code: "NOT_FOUND", message: "offer not found", requestId } },
        404,
      );
    }
    return jsonResponse(offer);
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
