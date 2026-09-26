import { and, desc, eq, inArray } from "drizzle-orm";

import type {
  DisruptionView,
  NotificationView,
  OfferSetView,
  PaxSummaryView,
  PnrDetailView,
  SagaView,
  VoucherView,
} from "@aviation/contracts";

import {
  auditEvents,
  confirmations,
  eventLog,
  flights,
  notifications,
  offers,
  offerOptions,
  pnr,
  pnrSegments,
  sagaSteps,
  sagas,
  vouchers,
} from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";

/**
 * Read-model builders for the passenger + agent surfaces (rebook-ai
 * api-contracts.md §1). Route handlers enforce the scoping: passengers
 * resolve only PNR rows linked to their user id (pnr.user_id, D-09);
 * agents/supervisors may read any booking (role ladder, PRD F-7).
 */

export interface PnrContext {
  pnrId: string;
  locator: string;
  passengerName: string;
  tier: "standard" | "silver" | "gold";
  fareClass: string;
  partySize: number;
  contactHandle: string;
}

/** PNRs owned by the logged-in user (empty for staff accounts — honest). */
export async function getOwnedPnrs(userId: string): Promise<PnrContext[]> {
  const db = getSingletonDb();
  return db
    .select({
      pnrId: pnr.id,
      locator: pnr.locator,
      passengerName: pnr.passengerName,
      tier: pnr.tier,
      fareClass: pnr.fareClass,
      partySize: pnr.partySize,
      contactHandle: pnr.contactHandle,
    })
    .from(pnr)
    .where(eq(pnr.userId, userId))
    .orderBy(pnr.createdAt);
}

export async function getPnrByLocator(locator: string): Promise<PnrContext | null> {
  const db = getSingletonDb();
  const [row] = await db
    .select({
      pnrId: pnr.id,
      locator: pnr.locator,
      passengerName: pnr.passengerName,
      tier: pnr.tier,
      fareClass: pnr.fareClass,
      partySize: pnr.partySize,
      contactHandle: pnr.contactHandle,
    })
    .from(pnr)
    .where(eq(pnr.locator, locator))
    .limit(1);
  return row ?? null;
}

/** Latest flight.disrupted event row for a flight id (source of truth). */
async function getDisruptionEvent(flightId: string) {
  const db = getSingletonDb();
  const [event] = await db
    .select({ occurredAt: eventLog.occurredAt, payload: eventLog.payload })
    .from(eventLog)
    .where(and(eq(eventLog.type, "flight.disrupted"), eq(eventLog.aggregateId, flightId)))
    .orderBy(desc(eventLog.id))
    .limit(1);
  return event ?? null;
}

/** The active disruption for a booking, from its segments + the flight rows. */
export async function getDisruptionForPnr(pnrId: string): Promise<DisruptionView | null> {
  const db = getSingletonDb();
  const rows = await db
    .select({
      flightNo: flights.flightNo,
      flightId: flights.id,
      flightStatus: flights.status,
      delayMinutes: flights.delayMinutes,
      origin: flights.origin,
      dest: flights.dest,
      schedDep: flights.schedDep,
    })
    .from(pnrSegments)
    .innerJoin(flights, eq(pnrSegments.flightNo, flights.flightNo))
    .where(eq(pnrSegments.pnrId, pnrId))
    .orderBy(pnrSegments.flightDate);

  const disrupted = rows.find(
    (row) => row.flightStatus === "cancelled" || row.flightStatus === "delayed",
  );
  if (!disrupted) return null;

  const event = await getDisruptionEvent(disrupted.flightId);
  return {
    flightNo: disrupted.flightNo,
    kind: disrupted.flightStatus === "cancelled" ? "cancellation" : "long_delay",
    delayMinutes: disrupted.flightStatus === "delayed" ? disrupted.delayMinutes : null,
    reasonCode: (event?.payload as { reasonCode?: string } | null)?.reasonCode ?? "UNKNOWN",
    origin: disrupted.origin,
    dest: disrupted.dest,
    schedDep: disrupted.schedDep.toISOString(),
    disruptedAt: (event?.occurredAt ?? new Date()).toISOString(),
  };
}

/** The saga opened for an offer (stub steps at F2 — executor lands in F3). */
async function getSagaByOffer(offerId: string): Promise<SagaView | null> {
  const db = getSingletonDb();
  const [saga] = await db
    .select()
    .from(sagas)
    .where(eq(sagas.offerId, offerId))
    .orderBy(desc(sagas.createdAt))
    .limit(1);
  if (!saga) return null;
  const steps = await db
    .select({ step: sagaSteps.step, state: sagaSteps.state })
    .from(sagaSteps)
    .where(eq(sagaSteps.sagaId, saga.id))
    .orderBy(sagaSteps.id);
  return {
    id: saga.id,
    state: saga.state,
    currentStep: saga.currentStep,
    steps: steps.map((s) => ({ step: s.step, state: s.state })),
  };
}

/** Documented option shape persisted in offer_options.itinerary (JSONB). */
interface StoredItinerary {
  segments: OfferSetView["options"][number]["segments"];
  currency: string;
  refundable: boolean;
  changeable: boolean;
  overCap: boolean;
}

export async function getOfferSetView(offerId: string): Promise<OfferSetView | null> {
  const db = getSingletonDb();
  const [offer] = await db.select().from(offers).where(eq(offers.id, offerId)).limit(1);
  if (!offer) return null;

  const options = await db
    .select()
    .from(offerOptions)
    .where(eq(offerOptions.offerId, offer.id))
    .orderBy(offerOptions.rank);

  const context = offer.context as OfferSetView["context"];
  const confirmationRow = (
    await db
      .select()
      .from(confirmations)
      .where(eq(confirmations.offerId, offer.id))
      .orderBy(desc(confirmations.createdAt))
      .limit(1)
  )[0];

  const sagaView = confirmationRow ? await getSagaByOffer(offer.id) : null;

  return {
    id: offer.id,
    pnrId: offer.pnrId,
    state: offer.state,
    expiresAt: offer.expiresAt.toISOString(),
    createdAt: offer.createdAt.toISOString(),
    options: options.map((option) => {
      const itinerary = option.itinerary as StoredItinerary;
      return {
        id: option.id,
        rank: option.rank,
        kind: option.kind,
        reason: option.reason,
        segments: itinerary.segments,
        fareDelta: option.fareDelta,
        currency: itinerary.currency,
        interline: option.interline,
        refundable: itinerary.refundable,
        changeable: itinerary.changeable,
        overCap: itinerary.overCap,
      };
    }),
    context,
    confirmation:
      confirmationRow && sagaView
        ? {
            optionId: confirmationRow.offerOptionId,
            byRole: confirmationRow.byRole,
            confirmedAt: confirmationRow.createdAt.toISOString(),
            saga: sagaView,
          }
        : null,
  };
}

export async function getLatestOfferViews(pnrId: string, limit = 1): Promise<OfferSetView[]> {
  const db = getSingletonDb();
  const rows = await db
    .select({ id: offers.id })
    .from(offers)
    .where(eq(offers.pnrId, pnrId))
    .orderBy(desc(offers.createdAt))
    .limit(limit);
  const views: OfferSetView[] = [];
  for (const row of rows) {
    const view = await getOfferSetView(row.id);
    if (view) views.push(view);
  }
  return views;
}

export async function getVoucherViews(pnrIds: string[]): Promise<VoucherView[]> {
  if (pnrIds.length === 0) return [];
  const db = getSingletonDb();
  const rows = await db
    .select()
    .from(vouchers)
    .where(inArray(vouchers.pnrId, pnrIds))
    .orderBy(desc(vouchers.createdAt));
  return rows.map((row) => ({
    id: row.id,
    amount: row.amount,
    currency: row.currency,
    state: row.state,
    reason: row.reason,
    criteria: row.criteria as VoucherView["criteria"],
    issuedAt: row.createdAt.toISOString(),
  }));
}

export async function getNotificationViews(pnrIds: string[]): Promise<NotificationView[]> {
  if (pnrIds.length === 0) return [];
  const db = getSingletonDb();
  const rows = await db
    .select()
    .from(notifications)
    .where(inArray(notifications.pnrId, pnrIds))
    .orderBy(desc(notifications.createdAt));
  return rows.map((row) => ({
    id: row.id,
    channel: "inbox" as const,
    state: row.state,
    subject: row.subject,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** GET /api/v1/pax/summary for one passenger login. */
export async function buildPaxSummary(session: {
  sub: string;
  email: string;
  name: string;
}): Promise<PaxSummaryView> {
  const owned = await getOwnedPnrs(session.sub);
  const pnrIds = owned.map((o) => o.pnrId);

  const offersList: OfferSetView[] = [];
  for (const context of owned) {
    offersList.push(...(await getLatestOfferViews(context.pnrId, 2)));
  }

  const disruptions = await Promise.all(pnrIds.map((id) => getDisruptionForPnr(id)));

  return {
    passenger: { name: session.name, email: session.email },
    disruption: disruptions.find((d) => d !== null) ?? null,
    offers: offersList,
    vouchers: await getVoucherViews(pnrIds),
    notifications: await getNotificationViews(pnrIds),
  };
}

/** GET /api/v1/pnr/{locator} for the agent console. */
export async function buildPnrDetail(context: PnrContext): Promise<PnrDetailView> {
  const db = getSingletonDb();
  const segments = await db
    .select({
      airline: pnrSegments.airline,
      flightNo: pnrSegments.flightNo,
      flightDate: pnrSegments.flightDate,
      origin: pnrSegments.origin,
      dest: pnrSegments.dest,
      cabin: pnrSegments.cabin,
      status: pnrSegments.status,
    })
    .from(pnrSegments)
    .where(eq(pnrSegments.pnrId, context.pnrId))
    .orderBy(pnrSegments.flightDate);

  return {
    locator: context.locator,
    passengerName: context.passengerName,
    tier: context.tier,
    fareClass: context.fareClass,
    partySize: context.partySize,
    contactHandle: context.contactHandle,
    segments: segments.map((s) => ({ ...s, flightDate: s.flightDate.toISOString() })),
    disruption: await getDisruptionForPnr(context.pnrId),
    offers: await getLatestOfferViews(context.pnrId, 3),
  };
}

/** Recent audit trail rows (append-only, PRD F-7). */
export async function getRecentAudit(limit = 20) {
  const db = getSingletonDb();
  return db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      actorRole: auditEvents.actorRole,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
}
