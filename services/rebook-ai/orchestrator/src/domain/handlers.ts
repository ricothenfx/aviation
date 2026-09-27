import { and, eq, lt } from "drizzle-orm";
import type { RedisClientType } from "@aviation/db/redis";

import { flightDisruptedPayloadSchema, offerConfirmedPayloadSchema } from "@aviation/contracts";
import { loadInventory, loadPolicy, seedDir } from "rebook-ai/seed-fixtures";

import type { OrchestratorDb } from "../db";
import { flights, offers, offerOptions, pnr, pnrSegments, sagas, vouchers } from "../db";
import { appendEvent, appendEvents } from "./event-log";
import { offersUpdateFrame, publishFrame, sagaUpdateFrame } from "./frames";
import { buildDisruptionPublishInput, type NotificationPublisher } from "./notifications";
import { scheduleQueueDelta } from "./queue";
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

  // Phase 1 (ADR-0016 amendment): pure per-PNR planning — voucher evaluation
  // and ranking stay per-PNR deterministic (F2 determinism gate untouched);
  // no writes happen here. Vouchers are planned for ALL affected bookings
  // meeting the policy criteria (F3 behavior); offers only where rebookable
  // inventory exists (honest: no inventory → no offer row).
  interface OfferPlan {
    booking: (typeof affected)[number];
    voucherDecision: ReturnType<typeof evaluateVoucher>;
    rankingHash: string;
    options: ReturnType<typeof rankOffers>["options"];
    expiresAt: Date;
  }
  interface VoucherPlan {
    booking: (typeof affected)[number];
    voucherDecision: ReturnType<typeof evaluateVoucher>;
  }
  const offerPlans: OfferPlan[] = [];
  const voucherPlans: VoucherPlan[] = [];
  const plannedVoucherFor = new Set<string>();
  for (const booking of affected) {
    const voucherDecision = evaluateVoucher({ disruption, tier: booking.tier, policy });
    if (voucherDecision.issued) {
      voucherPlans.push({ booking, voucherDecision });
      plannedVoucherFor.add(booking.pnrId);
    }
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
    if (options.length === 0) continue;

    offerPlans.push({
      booking,
      voucherDecision,
      rankingHash,
      options,
      expiresAt: new Date(now.getTime() + policy.offer.ttlMinutes * 60_000),
    });
  }

  // Phase 2: ONE multi-row insert per table for the whole event (the F4 code
  // issued ~8 round-trips per PNR — the ×10 wave measured 0.82 s/event).
  // Every insert is guarded: a flight with no affected bookings (or no
  // rebookable inventory) legitimately produces empty batches, and an empty
  // .values() is an error, not a no-op.
  const voucherIdsByPnr = new Map<string, string>();
  if (voucherPlans.length > 0) {
    const inserted = await db
      .insert(vouchers)
      .values(
        voucherPlans.map((p) => ({
          pnrId: p.booking.pnrId,
          amount: p.voucherDecision.amount,
          currency: p.voucherDecision.currency,
          state: "issued" as const,
          criteria: p.voucherDecision.criteria,
          reason: p.voucherDecision.reason,
        })),
      )
      .returning({ id: vouchers.id, pnrId: vouchers.pnrId });
    for (const row of inserted) voucherIdsByPnr.set(row.pnrId, row.id);
    metrics.counters["rb_orchestrator_vouchers_issued_total"] =
      (metrics.counters["rb_orchestrator_vouchers_issued_total"] ?? 0) + inserted.length;
  }

  let insertedOffers: { id: string; pnrId: string }[] = [];
  if (offerPlans.length > 0) {
    insertedOffers = await db
      .insert(offers)
      .values(
        offerPlans.map((p) => ({
          pnrId: p.booking.pnrId,
          state: "proposed" as const,
          context: {
            flightNo: disruption.flightNo,
            disruptionKind: disruption.kind,
            delayMinutes: disruption.delayMinutes,
            reasonCode: disruption.reasonCode,
            voucherIssued: plannedVoucherFor.has(p.booking.pnrId),
            rankingHash: p.rankingHash,
          },
          expiresAt: p.expiresAt,
        })),
      )
      .returning({ id: offers.id, pnrId: offers.pnrId });
    metrics.counters["rb_orchestrator_offers_created_total"] =
      (metrics.counters["rb_orchestrator_offers_created_total"] ?? 0) + insertedOffers.length;
  }

  if (insertedOffers.length > 0) {
    await db.insert(offerOptions).values(
      insertedOffers.flatMap((row, i) => {
        const plan = offerPlans[i]!;
        return plan.options.map((option) => ({
          offerId: row.id,
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
        }));
      }),
    );
  }

  await appendEvents(db, [
    ...voucherPlans.map((p) => ({
      type: "voucher.issued" as const,
      aggregateType: "voucher" as const,
      aggregateId: voucherIdsByPnr.get(p.booking.pnrId)!,
      payload: {
        voucherId: voucherIdsByPnr.get(p.booking.pnrId)!,
        pnrId: p.booking.pnrId,
        criteria: {
          reason: p.voucherDecision.reason,
          criteria: p.voucherDecision.criteria,
        },
      },
    })),
    ...insertedOffers.map((row, i) => ({
      type: "offer.created" as const,
      aggregateType: "offer" as const,
      aggregateId: row.id,
      payload: {
        pnrId: row.pnrId,
        offerId: row.id,
        optionCount: offerPlans[i]!.options.length,
        voucherIssued: plannedVoucherFor.has(row.pnrId),
      },
    })),
  ]);

  // 3. SNS-shaped notifications (PRD F-1) — one batched fan-out.
  await publisher.publishAll(
    insertedOffers.map((row, i) => {
      const plan = offerPlans[i]!;
      const voucherAmount = voucherIdsByPnr.has(plan.booking.pnrId)
        ? plan.voucherDecision.amount
        : null;
      return buildDisruptionPublishInput({
        pnrId: plan.booking.pnrId,
        locator: plan.booking.locator,
        passengerName: plan.booking.passengerName,
        flightNo: disruption.flightNo,
        disruptionKind: disruption.kind,
        delayMinutes: disruption.kind === "long_delay" ? disruption.delayMinutes : null,
        offerId: row.id,
        optionCount: plan.options.length,
        voucherAmount,
        voucherCurrency: plan.voucherDecision.currency,
        expiresAt: plan.expiresAt.toISOString(),
      });
    }),
  );
  metrics.counters["rb_orchestrator_notifications_sent_total"] =
    (metrics.counters["rb_orchestrator_notifications_sent_total"] ?? 0) + insertedOffers.length;

  for (const row of insertedOffers) {
    await publishFrame(
      redis,
      offersUpdateFrame(
        {
          pnrId: row.pnrId,
          offerId: row.id,
          state: "proposed",
          voucherIssued: voucherIdsByPnr.has(row.pnrId),
        },
        row.id,
      ),
    );
  }

  // 4. Queue projection (PRD F-4) — rebuildable from PG, fanned out live.
  // ADR-0016: coalesced + fire-and-forget — one rebuild + one queue.delta per
  // 250 ms window; the projection never blocks the domain pipeline.
  scheduleQueueDelta(db, redis, "disruption");
}

export async function handleOfferConfirmed(deps: HandlerDeps, payloadRaw: unknown): Promise<void> {
  const payload = offerConfirmedPayloadSchema.parse(payloadRaw);
  const { db, redis } = deps;

  scheduleQueueDelta(db, redis, "confirm");

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
    scheduleQueueDelta(db, redis, "expiry");
  }
  return expired.length;
}
