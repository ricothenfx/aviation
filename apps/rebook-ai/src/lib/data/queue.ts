import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { RedisClientType } from "@aviation/db/redis";

import { REBOOK_CONTROL_CHANNEL, type QueueSnapshotView } from "@aviation/contracts";

import {
  confirmations,
  eventLog,
  flights,
  offers,
  pnr,
  pnrSegments,
  proposals,
  sagas,
} from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { getSingletonRedis } from "@/lib/redis-singleton";

/**
 * Agent-queue read path (PRD F-4, data-model.md §3): the item order/priority
 * is read from the orchestrator's Redis ZSET projection; item details and the
 * containment metric always come from PostgreSQL (source of truth). When the
 * projection is missing (fresh flush) the web app requests a rebuild over the
 * control channel and re-reads — a Redis flush never loses truth
 * (architecture.md §4, ADR-0014/D-11 control-result pattern).
 */

export const QUEUE_KEY = "rb:queue:agent";

export async function getRedisPublisher(): Promise<RedisClientType> {
  return (await getSingletonRedis()).publisher;
}

/** Rebuild request over chan:rb:control; resolves when the result key appears. */
export async function requestQueueRebuild(timeoutMs = 4_000): Promise<boolean> {
  const redis = await getRedisPublisher();
  const requestId = crypto.randomUUID();
  const replyTo = `rb:result:${requestId}`;
  await redis.publish(
    REBOOK_CONTROL_CHANNEL,
    JSON.stringify({ id: requestId, type: "queue.rebuild", replyTo }),
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await redis.get(replyTo);
    if (result) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Full queue snapshot: ZSET order + PG hydration + containment metric. */
export async function readQueueSnapshot(redis: RedisClientType): Promise<QueueSnapshotView> {
  let members = await redis.zRangeWithScores(QUEUE_KEY, 0, -1);
  if (members.length === 0) {
    // Projection missing (flush/startup): rebuild via the control channel and
    // re-read once (architecture.md §4 — rebuild by replay).
    await requestQueueRebuild();
    members = await redis.zRangeWithScores(QUEUE_KEY, 0, -1);
  }
  const priorityByPnr = new Map(members.map((m) => [m.value, m.score]));

  const db = getSingletonDb();
  const brokenFlights = await db
    .select({ id: flights.id, flightNo: flights.flightNo })
    .from(flights)
    .where(ne(flights.status, "scheduled"));
  const flightIdByNo = new Map(brokenFlights.map((f) => [f.flightNo, f.id]));

  const rows =
    brokenFlights.length > 0
      ? await db
          .selectDistinctOn([pnr.id], {
            pnrId: pnr.id,
            locator: pnr.locator,
            passengerName: pnr.passengerName,
            tier: pnr.tier,
            partySize: pnr.partySize,
            flightNo: pnrSegments.flightNo,
          })
          .from(pnrSegments)
          .innerJoin(pnr, eq(pnrSegments.pnrId, pnr.id))
          .where(
            inArray(
              pnrSegments.flightNo,
              brokenFlights.map((f) => f.flightNo),
            ),
          )
      : [];

  const flightIds = brokenFlights.map((f) => f.id);
  const disruptionEvents =
    flightIds.length > 0
      ? await db
          .select({
            aggregateId: eventLog.aggregateId,
            payload: eventLog.payload,
            occurredAt: eventLog.occurredAt,
          })
          .from(eventLog)
          .where(
            and(eq(eventLog.type, "flight.disrupted"), inArray(eventLog.aggregateId, flightIds)),
          )
          .orderBy(desc(eventLog.id))
      : [];
  const disruptionByFlightId = new Map<string, { at: Date; kind: "cancellation" | "long_delay" }>();
  for (const event of disruptionEvents) {
    const payload = event.payload as { disruptionKind?: string };
    disruptionByFlightId.set(event.aggregateId, {
      at: event.occurredAt,
      kind: payload.disruptionKind === "long_delay" ? "long_delay" : "cancellation",
    });
  }

  const pnrIds = rows.map((r) => r.pnrId);
  // Served = the PNR's latest saga is active (running | completed) — mirrors
  // the orchestrator projection exactly (architecture §4: PG is the truth,
  // Redis only the live projection). A compensated saga re-queues the PNR.
  const sagaRows =
    pnrIds.length > 0
      ? await db
          .select({ pnrId: sagas.pnrId, state: sagas.state })
          .from(sagas)
          .where(inArray(sagas.pnrId, pnrIds))
          .orderBy(desc(sagas.createdAt))
      : [];
  const servedPnrs = new Set<string>();
  for (const saga of sagaRows) {
    if (servedPnrs.has(saga.pnrId)) continue; // latest saga wins
    if (saga.state === "running" || saga.state === "completed") servedPnrs.add(saga.pnrId);
  }
  // Self-serve containment: resolved AND the latest confirmation was the
  // passenger's own action (compensated sagas never count — honest metric).
  const confirmRows =
    pnrIds.length > 0
      ? await db
          .select({ pnrId: confirmations.pnrId, byRole: confirmations.byRole })
          .from(confirmations)
          .where(inArray(confirmations.pnrId, pnrIds))
          .orderBy(desc(confirmations.createdAt))
      : [];
  const selfServedPnrs = new Set<string>();
  for (const row of confirmRows) {
    if (selfServedPnrs.has(row.pnrId)) continue;
    if (row.byRole === "passenger" && servedPnrs.has(row.pnrId)) selfServedPnrs.add(row.pnrId);
  }

  const latestOffers =
    pnrIds.length > 0
      ? await db
          .select({ pnrId: offers.pnrId, state: offers.state, createdAt: offers.createdAt })
          .from(offers)
          .where(inArray(offers.pnrId, pnrIds))
          .orderBy(desc(offers.createdAt))
      : [];
  const offerStateByPnr = new Map<string, QueueSnapshotView["items"][number]["offerState"]>();
  for (const offer of latestOffers) {
    if (!offerStateByPnr.has(offer.pnrId)) offerStateByPnr.set(offer.pnrId, offer.state);
  }

  const now = Date.now();
  const items = rows
    .filter((row) => {
      if (servedPnrs.has(row.pnrId)) return false; // served → left the queue
      const flightId = flightIdByNo.get(row.flightNo);
      return (
        flightId !== undefined && disruptionByFlightId.has(flightId) && priorityByPnr.has(row.pnrId)
      );
    })
    .map((row) => {
      const flightId = flightIdByNo.get(row.flightNo) ?? "";
      const disruption = disruptionByFlightId.get(flightId);
      const disruptedAt = disruption?.at ?? new Date(now);
      return {
        pnrId: row.pnrId,
        locator: row.locator,
        passengerName: row.passengerName,
        tier: row.tier,
        partySize: row.partySize,
        flightNo: row.flightNo,
        disruptionKind: disruption?.kind ?? "cancellation",
        disruptedAt: disruptedAt.toISOString(),
        waitMinutes: Math.max(0, Math.round((now - disruptedAt.getTime()) / 60_000)),
        priority: priorityByPnr.get(row.pnrId) ?? 0,
        offerState: offerStateByPnr.get(row.pnrId) ?? null,
      };
    })
    .sort((a, b) => b.priority - a.priority);

  // Containment (PRD §5): share of disrupted PNRs resolved via self-serve —
  // counted from PG, not the projection.
  const containmentPct =
    rows.length === 0 ? null : Math.round((selfServedPnrs.size / rows.length) * 100);

  // F3 console tile: proposals awaiting a decision (PG source of truth).
  const openProposals = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(proposals)
    .where(eq(proposals.state, "proposed"));

  return {
    items,
    waiting: items.length,
    containmentPct,
    openProposals: openProposals[0]?.count ?? 0,
    generatedAt: new Date().toISOString(),
  };
}
