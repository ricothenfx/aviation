import { eq } from "drizzle-orm";

import type { RebookRole } from "@aviation/contracts";

import { confirmations, offers, offerOptions, pnr, sagaSteps, sagas } from "@/db/schema";
import { appendAuditEvent, appendEvent, type DbExecutor } from "@/lib/data/events";
import { getSingletonDb } from "@/lib/db-singleton";

/**
 * The one confirmation → saga path (architecture.md §3.2, ADR-0014 §4).
 * Passenger confirm (api-contracts.md §5) and agent-loop approval
 * (§3.3 "approval applies the proposal through the same saga path — no side
 * door") both land here: confirmation row + offer state + the saga and its
 * three idempotency-keyed steps + `offer.confirmed` + the audit row, all in
 * ONE transaction. The orchestrator's executor advances the steps from the
 * persisted state (crash-safe; F3).
 */

export interface ApplyConfirmationInput {
  offerId: string;
  optionId: string;
  byUserId: string;
  byRole: RebookRole;
  /** Exactly-one-effect key: client Idempotency-Key or `proposal:{id}`. */
  idempotencyKey: string;
  auditAction?: string;
}

export interface AppliedConfirmation {
  sagaId: string;
}

/** Documented option itinerary persisted in offer_options.itinerary (JSONB). */
interface StoredItinerary {
  segments: { flightNo: string }[];
  currency: string;
}

export async function applyConfirmation(
  input: ApplyConfirmationInput,
  exec: DbExecutor = getSingletonDb(),
): Promise<AppliedConfirmation> {
  const [booking] = await exec
    .select({ pnrId: offers.pnrId, partySize: pnr.partySize })
    .from(offers)
    .innerJoin(pnr, eq(offers.pnrId, pnr.id))
    .where(eq(offers.id, input.offerId))
    .limit(1);
  if (!booking) throw new Error("applyConfirmation: offer vanished mid-transaction");

  const [option] = await exec
    .select({ fareDelta: offerOptions.fareDelta, itinerary: offerOptions.itinerary })
    .from(offerOptions)
    .where(eq(offerOptions.id, input.optionId))
    .limit(1);
  if (!option) throw new Error("applyConfirmation: option vanished mid-transaction");
  const itinerary = option.itinerary as StoredItinerary;

  await exec.insert(confirmations).values({
    offerId: input.offerId,
    offerOptionId: input.optionId,
    pnrId: booking.pnrId,
    byUserId: input.byUserId,
    byRole: input.byRole,
    idempotencyKey: input.idempotencyKey,
  });
  await exec.update(offers).set({ state: "confirmed" }).where(eq(offers.id, input.offerId));

  const [saga] = await exec
    .insert(sagas)
    .values({
      pnrId: booking.pnrId,
      offerId: input.offerId,
      state: "running",
      currentStep: "seat_reserve",
    })
    .returning({ id: sagas.id });
  if (!saga) throw new Error("applyConfirmation: saga insert returned no row");

  // Simulated fulfillment stubs (PRD §4): deterministic requests the
  // orchestrator executor consumes — flight/seats for inventory accounting,
  // fare difference for the PSP charge (all simulated, honestly labeled).
  const primaryFlightNo = itinerary.segments[0]?.flightNo ?? "unknown";
  const requests: Record<string, unknown> = {
    seat_reserve: { flightNo: primaryFlightNo, seats: booking.partySize, simulated: true },
    payment: { amount: option.fareDelta, currency: itinerary.currency ?? "SGD", simulated: true },
    ticket_issue: { simulated: true },
  };
  await exec.insert(sagaSteps).values(
    (["seat_reserve", "payment", "ticket_issue"] as const).map((step) => ({
      sagaId: saga.id,
      step,
      state: "pending" as const,
      idempotencyKey: `${saga.id}:${step}`,
      request: requests[step],
    })),
  );

  await appendEvent(
    {
      type: "offer.confirmed",
      aggregateType: "offer",
      aggregateId: input.offerId,
      payload: {
        offerId: input.offerId,
        optionId: input.optionId,
        byRole: input.byRole,
        sagaId: saga.id,
      },
    },
    exec,
  );
  await appendAuditEvent(
    {
      actorId: input.byUserId,
      actorRole: input.byRole,
      action: input.auditAction ?? "offer.confirmed",
      targetType: "offer",
      targetId: input.offerId,
      details: { optionId: input.optionId, sagaId: saga.id, pnrId: booking.pnrId },
    },
    exec,
  );

  return { sagaId: saga.id };
}
