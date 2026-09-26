import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { proposalApproveResponseSchema } from "@aviation/contracts";

import { offers, offerOptions, proposals } from "@/db/schema";
import { withIdempotency } from "@/lib/api/idempotency";
import { handleRouteError, jsonResponse, requireSession, ApiError } from "@/lib/api/respond";
import { appendAuditEvent, appendEvent } from "@/lib/data/events";
import { applyConfirmation } from "@/lib/data/fulfillment";
import { getSingletonDb } from "@/lib/db-singleton";

export const dynamic = "force-dynamic";

const approveRequestSchema = z.object({ note: z.string().max(500).optional() });

/**
 * POST /api/v1/proposals/{id}/approve (api-contracts.md §1, architecture §3.3)
 * — agent+ role; interline / over-cap proposals require supervisor (403
 * FORBIDDEN otherwise). Applies the proposal through the ONE confirmation →
 * saga path (no side door): confirmation row, offer state, saga + steps,
 * `offer.confirmed`, plus the `proposal.approved` event and audit rows —
 * one transaction (PRD F-5 propose-only invariant ends exactly here).
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ proposalId: string }> },
): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    const session = await requireSession("agent");
    const { proposalId } = await context.params;
    const body = approveRequestSchema.parse(await request.json().catch(() => ({})));

    return await withIdempotency(request, {}, async () => {
      const db = getSingletonDb();
      const [proposal] = await db
        .select({
          id: proposals.id,
          state: proposals.state,
          recommendedOptionId: proposals.recommendedOptionId,
        })
        .from(proposals)
        .where(eq(proposals.id, proposalId))
        .limit(1);
      if (!proposal) throw new ApiError("NOT_FOUND", "proposal not found");
      if (proposal.state !== "proposed") {
        throw new ApiError("PROPOSAL_NOT_PENDING", "proposal has already been decided");
      }
      if (!proposal.recommendedOptionId) {
        throw new ApiError("PROPOSAL_NOT_PENDING", "proposal has no recommended option");
      }

      const [option] = await db
        .select({
          id: offerOptions.id,
          interline: offerOptions.interline,
          itinerary: offerOptions.itinerary,
          offerId: offerOptions.offerId,
        })
        .from(offerOptions)
        .where(eq(offerOptions.id, proposal.recommendedOptionId))
        .limit(1);
      if (!option) throw new ApiError("NOT_FOUND", "recommended option no longer exists");

      // Supervisor elevation gate (architecture.md §3.3, F3 DoD RBAC test).
      const itinerary = option.itinerary as { overCap?: boolean } | null;
      const requiresSupervisor = option.interline || itinerary?.overCap === true;
      if (requiresSupervisor && session.role !== "supervisor") {
        throw new ApiError(
          "FORBIDDEN",
          "interline or over-cap proposals require supervisor approval",
          { requiredRole: ["supervisor"] },
        );
      }

      const [offer] = await db
        .select({ state: offers.state, expiresAt: offers.expiresAt })
        .from(offers)
        .where(eq(offers.id, option.offerId))
        .limit(1);
      if (!offer) throw new ApiError("NOT_FOUND", "offer not found");
      if (offer.state !== "proposed" || offer.expiresAt <= new Date()) {
        throw new ApiError("OFFER_EXPIRED", "the offer behind this proposal is no longer active");
      }

      const sagaId = await db.transaction(async (tx) => {
        await tx
          .update(proposals)
          .set({
            state: "approved",
            approverId: session.sub,
            note: body.note ?? null,
            decidedAt: new Date(),
          })
          .where(eq(proposals.id, proposalId));

        const applied = await applyConfirmation(
          {
            offerId: option.offerId,
            optionId: option.id,
            byUserId: session.sub,
            byRole: session.role,
            idempotencyKey: `proposal:${proposalId}`,
          },
          tx,
        );

        await appendEvent(
          {
            type: "proposal.approved",
            aggregateType: "proposal",
            aggregateId: proposalId,
            payload: {
              proposalId,
              approverId: session.sub,
              ...(body.note ? { note: body.note } : {}),
            },
          },
          tx,
        );
        await appendAuditEvent(
          {
            actorId: session.sub,
            actorRole: session.role,
            action: "proposal.approved",
            targetType: "proposal",
            targetId: proposalId,
            details: {
              offerId: option.offerId,
              optionId: option.id,
              sagaId: applied.sagaId,
              note: body.note ?? null,
            },
          },
          tx,
        );
        return applied.sagaId;
      });

      return jsonResponse(
        proposalApproveResponseSchema.parse({
          proposalId,
          state: "approved",
          sagaId,
        }),
        201,
      );
    });
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
