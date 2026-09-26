import type { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { proposalRequestResponseSchema } from "@aviation/contracts";

import { offers, offerOptions, pnr } from "@/db/schema";
import { requestOrchestrator } from "@/lib/api/control";
import { withIdempotency } from "@/lib/api/idempotency";
import { handleRouteError, jsonResponse, requireSession, ApiError } from "@/lib/api/respond";
import { getSingletonDb } from "@/lib/db-singleton";

export const dynamic = "force-dynamic";

const PROPOSAL_WAIT_MS = 12_000; // agent loop budget < 15 s (milestones.md F3)

/**
 * POST /api/v1/pnr/{locator}/proposal (api-contracts.md §1, architecture §3.3)
 * — agent/supervisor requests a propose-only agent-loop proposal. The web app
 * enqueues the request over the control channel (browser never reaches the
 * orchestrator, ADR-0014); the orchestrator runs the bounded tool loop and
 * persists the proposal. Returns the proposal id immediately-shaped: the
 * client polls GET /api/v1/proposals/{id} (404 while the loop still runs —
 * the console renders that as an honest "preparing" state).
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ locator: string }> },
): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    await requireSession("agent");
    const { locator } = await context.params;

    return await withIdempotency(request, {}, async () => {
      const db = getSingletonDb();
      const [booking] = await db
        .select({ pnrId: pnr.id })
        .from(pnr)
        .where(eq(pnr.locator, locator.toUpperCase()))
        .limit(1);
      if (!booking) throw new ApiError("NOT_FOUND", "PNR not found");

      const [offer] = await db
        .select({ id: offers.id })
        .from(offers)
        .where(and(eq(offers.pnrId, booking.pnrId), eq(offers.state, "proposed")))
        .orderBy(desc(offers.createdAt))
        .limit(1);
      if (!offer) {
        throw new ApiError("NOT_FOUND", "no active rebooking offer for this PNR");
      }
      const optionCount = await db
        .select({ id: offerOptions.id })
        .from(offerOptions)
        .where(eq(offerOptions.offerId, offer.id))
        .limit(1);
      if (optionCount.length === 0) {
        throw new ApiError("NOT_FOUND", "offer has no ranked options");
      }

      // Pre-generate the proposal id so the response is stable across
      // Idempotency-Key replays and the client can poll before completion.
      const proposalId = crypto.randomUUID();
      const outcome = await requestOrchestrator<{ proposalId?: string }>(
        "proposal.request",
        { proposalId, pnrId: booking.pnrId, offerId: offer.id },
        PROPOSAL_WAIT_MS,
      );
      if (outcome.kind === "error") {
        throw new ApiError("INTERNAL", `agent loop failed: ${outcome.message}`);
      }
      // ok (loop finished) or timeout (loop still running — keep polling).

      return jsonResponse(proposalRequestResponseSchema.parse({ proposalId }), 201);
    });
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
