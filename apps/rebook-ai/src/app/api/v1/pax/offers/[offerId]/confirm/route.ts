import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { offerConfirmRequestSchema, offerConfirmResponseSchema } from "@aviation/contracts";

import { confirmations, offers, offerOptions, pnr, sagaSteps, sagas } from "@/db/schema";
import { withIdempotency } from "@/lib/api/idempotency";
import { handleRouteError, jsonResponse, requireSession, ApiError } from "@/lib/api/respond";
import { appendAuditEvent, appendEvent } from "@/lib/data/events";
import { getSingletonDb } from "@/lib/db-singleton";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/pax/offers/{offerId}/confirm (rebook-ai api-contracts.md §1/§5)
 * — one-tap confirm with a REQUIRED Idempotency-Key:
 * - same key ⇒ stored response replayed (PG replay store, crash-safe)
 * - already-confirmed offer with a different key ⇒ 409 IDEMPOTENCY_CONFLICT
 * - expired offer ⇒ 409 OFFER_EXPIRED (no saga opens)
 * - interline option for a passenger ⇒ 403 FORBIDDEN (agent/supervisor path)
 * Confirm opens the fulfillment saga (ADR-0014) with its three stub steps —
 * the executor advancing them lands in F3 — appends `offer.confirmed` in the
 * same transaction as the state change, and writes the audit row (PRD F-7).
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ offerId: string }> },
): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    const session = await requireSession("passenger");
    const { offerId } = await context.params;
    const body = offerConfirmRequestSchema.parse(await request.json().catch(() => ({})));
    const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";

    return await withIdempotency(request, { requireKey: true }, async () => {
      const db = getSingletonDb();
      const [row] = await db
        .select({
          offerId: offers.id,
          state: offers.state,
          expiresAt: offers.expiresAt,
          pnrId: offers.pnrId,
          ownerUserId: pnr.userId,
        })
        .from(offers)
        .innerJoin(pnr, eq(offers.pnrId, pnr.id))
        .where(eq(offers.id, offerId))
        .limit(1);

      const isOwner = row?.ownerUserId != null && row.ownerUserId === session.sub;
      if (!row || (session.role === "passenger" && !isOwner)) {
        throw new ApiError("NOT_FOUND", "offer not found");
      }

      // Authorization first (architecture.md §5): the interline gate applies
      // regardless of offer state — a passenger gets 403, never a state error.
      const [option] = await db
        .select({
          id: offerOptions.id,
          interline: offerOptions.interline,
          offerId: offerOptions.offerId,
        })
        .from(offerOptions)
        .where(eq(offerOptions.id, body.optionId))
        .limit(1);
      if (!option || option.offerId !== offerId) {
        throw new ApiError("NOT_FOUND", "option not found for this offer");
      }
      if (option.interline && session.role === "passenger") {
        throw new ApiError("FORBIDDEN", "interline options require agent or supervisor assistance");
      }

      // Expiry is checked on state AND on the clock — an expired offer can
      // never open a saga, even before the sweep transitions it (§5).
      if (row.state === "expired" || row.state === "superseded" || row.expiresAt <= new Date()) {
        throw new ApiError("OFFER_EXPIRED", "this offer has expired");
      }

      const [existingConfirmation] = await db
        .select({ idempotencyKey: confirmations.idempotencyKey })
        .from(confirmations)
        .where(eq(confirmations.offerId, offerId))
        .limit(1);
      if (existingConfirmation) {
        if (existingConfirmation.idempotencyKey !== idempotencyKey) {
          throw new ApiError(
            "IDEMPOTENCY_CONFLICT",
            "offer already confirmed with a different Idempotency-Key",
          );
        }
        // Same key racing the replay store: resolve the existing saga and
        // return the identical response (exactly-one-effect, §5).
        const [sagaRow] = await db
          .select({ id: sagas.id, state: sagas.state })
          .from(sagas)
          .where(eq(sagas.offerId, offerId))
          .limit(1);
        return jsonResponse(
          offerConfirmResponseSchema.parse({
            offerId,
            optionId: body.optionId,
            sagaId: sagaRow?.id ?? "",
            sagaState: sagaRow?.state ?? "running",
          }),
        );
      }

      const result = await db.transaction(async (tx) => {
        await tx.insert(confirmations).values({
          offerId,
          offerOptionId: body.optionId,
          pnrId: row.pnrId,
          byUserId: session.sub,
          byRole: session.role,
          idempotencyKey,
        });
        await tx.update(offers).set({ state: "confirmed" }).where(eq(offers.id, offerId));

        const [saga] = await tx
          .insert(sagas)
          .values({
            pnrId: row.pnrId,
            offerId,
            state: "running",
            currentStep: "seat_reserve",
          })
          .returning({ id: sagas.id });
        if (!saga) throw new Error("saga insert returned no row");

        await tx.insert(sagaSteps).values(
          (["seat_reserve", "payment", "ticket_issue"] as const).map((step) => ({
            sagaId: saga.id,
            step,
            state: "pending" as const,
            idempotencyKey: `${saga.id}:${step}`,
            request: { simulated: true, note: "F2 stub — executor lands in F3 (ADR-0014)" },
          })),
        );

        await appendEvent(
          {
            type: "offer.confirmed",
            aggregateType: "offer",
            aggregateId: offerId,
            payload: {
              offerId,
              optionId: body.optionId,
              byRole: session.role,
              sagaId: saga.id,
            },
          },
          tx,
        );
        await appendAuditEvent(
          {
            actorId: session.sub,
            actorRole: session.role,
            action: "offer.confirmed",
            targetType: "offer",
            targetId: offerId,
            details: { optionId: body.optionId, sagaId: saga.id, pnrId: row.pnrId },
          },
          tx,
        );
        return saga;
      });

      return jsonResponse(
        offerConfirmResponseSchema.parse({
          offerId,
          optionId: body.optionId,
          sagaId: result.id,
          sagaState: "running",
        }),
        201,
      );
    });
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
