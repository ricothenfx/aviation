import { and, eq, lt } from "drizzle-orm";
import type { RedisClientType } from "@aviation/db/redis";

import { flightDisruptedPayloadSchema, offerConfirmedPayloadSchema } from "@aviation/contracts";
import { loadInventory, loadPolicy, seedDir } from "rebook-ai/seed-fixtures";

import type { OrchestratorDb } from "../db";
import { flights, offers, offerOptions, pnr, pnrSegments, sagas, vouchers } from "../db";
import { appendEvent } from "./event-log";
import { offersUpdateFrame, publishFrame, queueDeltaFrame, sagaUpdateFrame } from "./frames";
import { buildDisruptionPublishInput, type NotificationPublisher } from "./notifications";
import { createQueueProjector } from "./queue";
import { rankOffers, type DisruptionContext, type RankingPnr } from "./ranking";
import { advanceSaga } from "./saga";
import { evaluateVoucher } from "./vouchers";

/**
 * Event handlers for the orchestrator tail (architecture.md §3.1):
 * - `flight.disrupted` → voucher evaluation + ranked offers + inbox
 *   notification + queue projection per affected PNR (proactive pipeline).
 * - `offer.confirmed` → the PNR left the queue; refresh projections and fan
 *   out the saga frame. (The confirm write itself happens in the web app —
 *   the orchestrator only maintains the live projections.)
 */

export interface EngineMetrics {
  counters: Record<string, number>;
}

function bump(metrics: EngineMetrics, name: string): void {
  metrics.counters[name] = (metrics.counters[name] ?? 0) + 1;
}

interface HandlerDeps {
  db: OrchestratorDb;
  redis: RedisClientType;
  publisher: NotificationPublisher;
  metrics: EngineMetrics;
  onLog: (msg: string, fields?: Record<string, unknown>) => void;
}

function fareRulesOf(document: unknown): { refundable: boolean; changeable: boolean } {
  const doc = document as { fareRules?: { refundable?: boolean; changeable?: boolean } } | null;
  return {
    refundable: doc?.fareRules?.refundable ?? false,
    changeable: doc?.fareRules?.changeable ?? false,
  };
}

export async function handleFlightDisrupted(deps: HandlerDeps, payloadRaw: unknown): Promise<void> {
  const payload = flightDisruptedPayloadSchema.parse(payloadRaw);
  const { db, redis, publisher, metrics } = deps;

  const [flight] = await db.select().from(flights).where(eq(flights.flightNo, payload.flightNo));
  if (!flight) {
    // Not poison — a disruption for an unknown flight is a no-op with a note.
    throw new Error(`flight.disrupted for unknown flight ${payload.flightNo}`);
  }
  if (flight.status !== "scheduled") {
    // Idempotency guard (ADR-0014 §4): a retry after a mid-handler crash must
    // not duplicate offers/vouchers/notifications. The flight row transition
    // happens inside this handler, so a disrupted status means this event's
    // effects already landed (partially or fully) — treat as consumed.
    deps.onLog("disruption_already_applied", { flightNo: payload.flightNo });
    return;
  }

  const affected = await db
    .select({
      pnrId: pnr.id,
      locator: pnr.locator,
      passengerName: pnr.passengerName,
      tier: pnr.tier,
      fareClass: pnr.fareClass,
      partySize: pnr.partySize,
      document: pnr.document,
    })
    .from(pnrSegments)
    .innerJoin(pnr, eq(pnrSegments.pnrId, pnr.id))
    .where(and(eq(pnrSegments.flightNo, payload.flightNo), eq(pnrSegments.status, "confirmed")));

  // Reflect the disruption on the booked segments (honest PNR view).
  await db
    .update(pnrSegments)
    .set({ status: payload.disruptionKind === "cancellation" ? "cancelled" : "delayed" })
    .where(and(eq(pnrSegments.flightNo, payload.flightNo), eq(pnrSegments.status, "confirmed")));

  // Flight row status transition (source-of-truth state for queue/summary).
  await db
    .update(flights)
    .set({
      status: payload.disruptionKind === "cancellation" ? "cancelled" : "delayed",
      delayMinutes: payload.disruptionKind === "long_delay" ? payload.delayMinutes : 0,
    })
    .where(eq(flights.id, flight.id));

  const inventory = loadInventory(seedDir()).candidates;
  const policy = loadPolicy(seedDir());
  const now = new Date();

  const disruption: DisruptionContext = {
    flightNo: flight.flightNo,
    origin: flight.origin,
    dest: flight.dest,
    schedDep: flight.schedDep.toISOString(),
    schedArr: flight.schedArr.toISOString(),
    kind: payload.disruptionKind,
    delayMinutes: payload.delayMinutes,
    reasonCode: payload.reasonCode,
  };

  for (const booking of affected) {
    // 1. Voucher (PRD F-3) — explainable criteria persisted verbatim.
    const voucherDecision = evaluateVoucher({ disruption, tier: booking.tier, policy });
    let voucherAmount: number | null = null;
    if (voucherDecision.issued) {
      const [voucherRow] = await db
        .insert(vouchers)
        .values({
          pnrId: booking.pnrId,
          amount: voucherDecision.amount,
          currency: voucherDecision.currency,
          state: "issued",
          criteria: voucherDecision.criteria,
          reason: voucherDecision.reason,
        })
        .returning({ id: vouchers.id });
      if (voucherRow) {
        voucherAmount = voucherDecision.amount;
        bump(metrics, "rb_orchestrator_vouchers_issued_total");
        await appendEvent(db, {
          type: "voucher.issued",
          aggregateType: "voucher",
          aggregateId: voucherRow.id,
          payload: {
            voucherId: voucherRow.id,
            pnrId: booking.pnrId,
            criteria: { reason: voucherDecision.reason, criteria: voucherDecision.criteria },
          },
        });
      }
    }

    // 2. Ranked offers (PRD F-2) — deterministic engine over the inventory.
    const rankingPnr: RankingPnr = {
      id: booking.pnrId,
      locator: booking.locator,
      tier: booking.tier,
      fareClass: booking.fareClass,
      partySize: booking.partySize,
      ...fareRulesOf(booking.document),
    };
    const { options, rankingHash } = rankOffers({
      pnr: rankingPnr,
      disruption,
      inventory,
      policy,
      now,
    });
    if (options.length === 0) continue; // honest: no inventory → no offer row

    const expiresAt = new Date(now.getTime() + policy.offer.ttlMinutes * 60_000);
    const [offerRow] = await db
      .insert(offers)
      .values({
        pnrId: booking.pnrId,
        state: "proposed",
        context: {
          flightNo: disruption.flightNo,
          disruptionKind: disruption.kind,
          delayMinutes: disruption.delayMinutes,
          reasonCode: disruption.reasonCode,
          voucherIssued: voucherDecision.issued,
          rankingHash,
        },
        expiresAt,
      })
      .returning({ id: offers.id });
    if (!offerRow) continue;

    await db.insert(offerOptions).values(
      options.map((option) => ({
        offerId: offerRow.id,
        rank: option.rank,
        kind: option.kind,
        reason: option.reason,
        itinerary: {
          segments: option.segments,
          currency: option.currency,
          refundable: option.refundable,
          changeable: option.changeable,
          overCap: option.overCap,
        },
        fareDelta: option.fareDelta,
        interline: option.interline,
      })),
    );
    bump(metrics, "rb_orchestrator_offers_created_total");

    await appendEvent(db, {
      type: "offer.created",
      aggregateType: "offer",
      aggregateId: offerRow.id,
      payload: {
        pnrId: booking.pnrId,
        offerId: offerRow.id,
        optionCount: options.length,
        voucherIssued: voucherDecision.issued,
      },
    });

    // 3. SNS-shaped notification (PRD F-1) — simulated inbox delivery.
    await publisher.publish(
      buildDisruptionPublishInput({
        pnrId: booking.pnrId,
        locator: booking.locator,
        passengerName: booking.passengerName,
        flightNo: disruption.flightNo,
        disruptionKind: disruption.kind,
        delayMinutes: disruption.kind === "long_delay" ? disruption.delayMinutes : null,
        offerId: offerRow.id,
        optionCount: options.length,
        voucherAmount,
        voucherCurrency: voucherDecision.currency,
        expiresAt: expiresAt.toISOString(),
      }),
    );
    bump(metrics, "rb_orchestrator_notifications_sent_total");

    await publishFrame(
      redis,
      offersUpdateFrame(
        {
          pnrId: booking.pnrId,
          offerId: offerRow.id,
          state: "proposed",
          voucherIssued: voucherDecision.issued,
        },
        offerRow.id,
      ),
    );
  }

  // 4. Queue projection (PRD F-4) — rebuildable from PG, fanned out live.
  const projector = createQueueProjector(db, redis);
  const delta = await projector.rebuild();
  await publishFrame(redis, queueDeltaFrame({ ...delta, reason: "disruption" }, null));
}

export async function handleOfferConfirmed(deps: HandlerDeps, payloadRaw: unknown): Promise<void> {
  const payload = offerConfirmedPayloadSchema.parse(payloadRaw);
  const { db, redis } = deps;

  const projector = createQueueProjector(db, redis);
  const delta = await projector.rebuild();
  await publishFrame(redis, queueDeltaFrame({ ...delta, reason: "confirm" }, payload.offerId));

  if (payload.sagaId) {
    const [saga] = await db
      .select({
        id: sagas.id,
        state: sagas.state,
        currentStep: sagas.currentStep,
        pnrId: sagas.pnrId,
      })
      .from(sagas)
      .where(eq(sagas.id, payload.sagaId));
    if (saga) {
      await publishFrame(
        redis,
        sagaUpdateFrame(
          { pnrId: saga.pnrId, sagaId: saga.id, state: saga.state, currentStep: saga.currentStep },
          payload.offerId,
        ),
      );
      // F3: drive the fulfillment saga from the persisted step state
      // (architecture.md §3.2). advanceSaga is idempotent, so duplicate
      // confirm deliveries and crash re-drives are exactly-once.
      await advanceSaga(deps, saga.id);
    }
  }
}

/** Offer expiry sweep (architecture.md §3.1): honest expiry transitions. */
export async function expireOffers(deps: HandlerDeps): Promise<number> {
  const { db, redis } = deps;
  const expired = await db
    .update(offers)
    .set({ state: "expired" })
    .where(and(eq(offers.state, "proposed"), lt(offers.expiresAt, new Date())))
    .returning({ id: offers.id, pnrId: offers.pnrId });

  for (const offer of expired) {
    await appendEvent(db, {
      type: "offer.expired",
      aggregateType: "offer",
      aggregateId: offer.id,
      payload: { offerId: offer.id, reason: "offer TTL elapsed without confirmation" },
    });
    await publishFrame(
      redis,
      offersUpdateFrame({ pnrId: offer.pnrId, offerId: offer.id, state: "expired" }, offer.id),
    );
  }

  if (expired.length > 0) {
    const projector = createQueueProjector(db, redis);
    const delta = await projector.rebuild();
    await publishFrame(redis, queueDeltaFrame({ ...delta, reason: "expiry" }, null));
  }
  return expired.length;
}
