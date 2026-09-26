import { desc, eq, inArray, sql } from "drizzle-orm";
import type { RedisClientType } from "@aviation/db/redis";

import type { QueueDeltaPayload, QueueItemView, QueueSnapshotView } from "@aviation/contracts";

import type { OrchestratorDb } from "../db";
import { confirmations, eventLog, flights, offers, pnr, pnrSegments } from "../db";

/**
 * Live agent-queue projection (PRD F-4, data-model.md §3): the ZSET
 * `rb:queue:agent` holds one member per disrupted PNR awaiting resolution,
 * scored by tier + disruption kind + SSR + wait (higher = served first).
 * Redis is a disposable projection — `rebuildQueue` recomputes it from
 * PostgreSQL (event_log + state tables), so a flush never loses truth
 * (architecture.md §4). Pure scoring lives in `queuePriority`.
 */

export const QUEUE_KEY = "rb:queue:agent";

const TIER_BASE: Record<"standard" | "silver" | "gold", number> = {
  standard: 100,
  silver: 200,
  gold: 300,
};
const KIND_BONUS: Record<"cancellation" | "long_delay", number> = {
  cancellation: 100,
  long_delay: 40,
};
const SSR_BONUS = 30;
const WAIT_CAP_MINUTES = 240;

export interface QueuePriorityInput {
  tier: "standard" | "silver" | "gold";
  kind: "cancellation" | "long_delay";
  ssr: boolean;
  waitMinutes: number;
}

/** Deterministic priority score (PRD F-4: tier/SLA first). */
export function queuePriority(input: QueuePriorityInput): number {
  return (
    TIER_BASE[input.tier] +
    KIND_BONUS[input.kind] +
    (input.ssr ? SSR_BONUS : 0) +
    Math.min(input.waitMinutes, WAIT_CAP_MINUTES)
  );
}

function hasSsr(document: unknown): boolean {
  const doc = document as { ssr?: unknown } | null;
  return Array.isArray(doc?.ssr) && doc.ssr.length > 0;
}

export interface QueueProjector {
  rebuild(): Promise<QueueDeltaPayload>;
  snapshot(): Promise<QueueSnapshotView>;
}

/** PG-side view of every disrupted PNR + its queue state (source of truth). */
export interface DisruptedPnrRow {
  pnrId: string;
  locator: string;
  passengerName: string;
  tier: "standard" | "silver" | "gold";
  partySize: number;
  flightNo: string;
  disruptionKind: "cancellation" | "long_delay";
  disruptedAt: Date;
  ssr: boolean;
  offerState: "proposed" | "confirmed" | "expired" | "superseded" | null;
}

/**
 * Disrupted PNRs straight from PostgreSQL: flights broken (status ≠
 * scheduled) × confirmed segments, excluding PNRs that already confirmed an
 * offer (self-served or agent-served — they left the queue, PRD F-4). The
 * disruption timestamp comes from the latest flight.disrupted event per
 * flight, so the projection is fully rebuildable by replay (data-model.md §3).
 */
export async function loadDisruptedPnrs(db: OrchestratorDb): Promise<DisruptedPnrRow[]> {
  const brokenFlights = await db
    .select({
      id: flights.id,
      flightNo: flights.flightNo,
      status: flights.status,
      delayMinutes: flights.delayMinutes,
    })
    .from(flights)
    .where(sql`${flights.status} <> 'scheduled'`);
  if (brokenFlights.length === 0) return [];

  const flightNos = brokenFlights.map((f) => f.flightNo);
  const rows = await db
    .selectDistinctOn([pnr.id], {
      pnrId: pnr.id,
      locator: pnr.locator,
      passengerName: pnr.passengerName,
      tier: pnr.tier,
      partySize: pnr.partySize,
      document: pnr.document,
      flightNo: pnrSegments.flightNo,
    })
    .from(pnrSegments)
    .innerJoin(pnr, eq(pnrSegments.pnrId, pnr.id))
    .where(inArray(pnrSegments.flightNo, flightNos));

  const confirmRows = await db
    .select({ pnrId: confirmations.pnrId })
    .from(confirmations)
    .where(
      inArray(
        confirmations.pnrId,
        rows.map((r) => r.pnrId),
      ),
    );
  const confirmedPnrs = new Set(confirmRows.map((r) => r.pnrId));

  const disruptionEvents = await db
    .select({
      aggregateId: eventLog.aggregateId,
      payload: eventLog.payload,
      occurredAt: eventLog.occurredAt,
    })
    .from(eventLog)
    .where(eq(eventLog.type, "flight.disrupted"))
    .orderBy(desc(eventLog.id));
  const disruptedAtByFlight = new Map<string, { at: Date; kind: "cancellation" | "long_delay" }>();
  for (const event of disruptionEvents) {
    const flight = brokenFlights.find((f) => f.id === event.aggregateId);
    if (!flight) continue;
    const payload = event.payload as { disruptionKind?: string };
    disruptedAtByFlight.set(flight.flightNo, {
      at: event.occurredAt,
      kind: payload.disruptionKind === "long_delay" ? "long_delay" : "cancellation",
    });
  }

  const result: DisruptedPnrRow[] = [];
  for (const row of rows) {
    if (confirmedPnrs.has(row.pnrId)) continue;
    const disruption = disruptedAtByFlight.get(row.flightNo);
    if (!disruption) continue;
    const [latestOffer] = await db
      .select({ state: offers.state })
      .from(offers)
      .where(eq(offers.pnrId, row.pnrId))
      .orderBy(desc(offers.createdAt))
      .limit(1);
    result.push({
      pnrId: row.pnrId,
      locator: row.locator,
      passengerName: row.passengerName,
      tier: row.tier,
      partySize: row.partySize,
      flightNo: row.flightNo,
      disruptionKind: disruption.kind,
      disruptedAt: disruption.at,
      ssr: hasSsr(row.document),
      offerState: latestOffer?.state ?? null,
    });
  }
  return result;
}

/** Containment (PRD §5): share of disrupted PNRs resolved via self-serve. */
export async function containment(db: OrchestratorDb): Promise<number | null> {
  const brokenFlights = await db
    .select({ id: flights.id, flightNo: flights.flightNo })
    .from(flights)
    .where(sql`${flights.status} <> 'scheduled'`);
  if (brokenFlights.length === 0) return null;
  const flightNos = brokenFlights.map((f) => f.flightNo);
  const disrupted = await db
    .selectDistinct({ pnrId: pnr.id })
    .from(pnrSegments)
    .innerJoin(pnr, eq(pnrSegments.pnrId, pnr.id))
    .where(inArray(pnrSegments.flightNo, flightNos));
  if (disrupted.length === 0) return null;
  const served = await db
    .select({ pnrId: confirmations.pnrId, byRole: confirmations.byRole })
    .from(confirmations)
    .where(
      inArray(
        confirmations.pnrId,
        disrupted.map((d) => d.pnrId),
      ),
    );
  const selfServed = served.filter((s) => s.byRole === "passenger").length;
  return Math.round((selfServed / disrupted.length) * 100);
}

export function createQueueProjector(db: OrchestratorDb, redis: RedisClientType): QueueProjector {
  async function rebuild(): Promise<QueueDeltaPayload> {
    const rows = await loadDisruptedPnrs(db);
    const now = Date.now();
    await redis.del(QUEUE_KEY);
    if (rows.length > 0) {
      const scored = rows.map((row) => ({
        member: row.pnrId,
        score: queuePriority({
          tier: row.tier,
          kind: row.disruptionKind,
          ssr: row.ssr,
          waitMinutes: Math.max(0, Math.round((now - row.disruptedAt.getTime()) / 60_000)),
        }),
      }));
      await redis.zAdd(
        QUEUE_KEY,
        scored.map((s) => ({ score: s.score, value: s.member })),
      );
    }
    const waiting = rows.length;
    const containmentPct = await containment(db);
    return { waiting, containmentPct, reason: "rebuild" };
  }

  async function snapshot(): Promise<QueueSnapshotView> {
    const members = await redis.zRangeWithScores(QUEUE_KEY, 0, -1);
    const sorted = [...members].sort((a, b) => b.score - a.score);
    const byId = new Map(sorted.map((m) => [m.value, m.score]));
    const items: QueueItemView[] = [];
    if (byId.size > 0) {
      const rows = await loadDisruptedPnrs(db);
      for (const row of rows) {
        const priority = byId.get(row.pnrId);
        if (priority === undefined) continue;
        items.push({
          pnrId: row.pnrId,
          locator: row.locator,
          passengerName: row.passengerName,
          tier: row.tier,
          partySize: row.partySize,
          flightNo: row.flightNo,
          disruptionKind: row.disruptionKind,
          disruptedAt: row.disruptedAt.toISOString(),
          waitMinutes: Math.max(0, Math.round((Date.now() - row.disruptedAt.getTime()) / 60_000)),
          priority,
          offerState: row.offerState,
        });
      }
    }
    const waiting = items.length;
    const containmentPct = await containment(db);
    return { items, waiting, containmentPct, generatedAt: new Date().toISOString() };
  }

  return { rebuild, snapshot };
}
