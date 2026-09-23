import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@aviation/db/client";
import { alerts, events, flights, groundTasks, replanScenarios } from "@aviation/db/schema";
import {
  ApiError,
  domainEventSchema,
  flightDetailSchema,
  type FlightDetail,
  type FlightProjection,
  type AlertProjection,
  type CursorPage,
  cursorPageSchema,
  type DomainEvent,
} from "@aviation/contracts";

/**
 * Flight audit reads (api-contracts.md §1): flight detail (projection + alert
 * lifecycle) and cursor-paginated event replay per flight + global catch-up.
 */

const EVENT_PAGE_LIMIT = 100;
const EVENT_CATCHUP_LIMIT = 500;

function toDomainEvent(row: typeof events.$inferSelect): DomainEvent {
  return {
    id: row.id,
    type: row.type as DomainEvent["type"],
    occurredAt: row.occurredAt.toISOString(),
    aggregateId: row.aggregateId,
    aggregateType: row.aggregateType,
    sequence: row.sequence,
    payload: row.payload,
  };
}

/** Flight + tasks + alert lifecycle for the drawer (ui-design-system.md §5.2). */
export async function getFlightDetail(db: Db, flight: FlightProjection): Promise<FlightDetail> {
  const alertRows = await db
    .select()
    .from(alerts)
    .where(eq(alerts.flightId, flight.id))
    .orderBy(asc(alerts.raisedAt));
  const alertProjections: AlertProjection[] = alertRows.map((row) => ({
    id: row.id,
    flightId: row.flightId,
    ruleId: row.ruleId,
    severity: row.severity,
    state: row.state,
    raisedAt: row.raisedAt.toISOString(),
    leadTimeMin:
      row.detail && typeof row.detail === "object" && "leadTimeMin" in row.detail
        ? ((row.detail as { leadTimeMin: number | null }).leadTimeMin ?? null)
        : null,
  }));
  return flightDetailSchema.parse({ flight, alerts: alertProjections });
}

/**
 * Cursor-paginated audit replay for one flight: its own + its tasks' + its
 * replans' events (PRD F-4: the approve/reject decision trail must be visible
 * in the flight context; replan events aggregate on the replan id).
 */
export async function listFlightEvents(
  db: Db,
  flightId: string,
  cursor: number | null,
): Promise<CursorPage<DomainEvent>> {
  const [taskIds, replanIds] = await Promise.all([
    db.select({ id: groundTasks.id }).from(groundTasks).where(eq(groundTasks.flightId, flightId)),
    db
      .select({ id: replanScenarios.id })
      .from(replanScenarios)
      .where(eq(replanScenarios.flightId, flightId)),
  ]);
  const aggregateIds = [flightId, ...taskIds.map((t) => t.id), ...replanIds.map((r) => r.id)];

  const conditions = [inArray(events.aggregateId, aggregateIds)];
  if (cursor !== null) conditions.push(gt(events.seq, cursor));

  const rows = await db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(asc(events.seq))
    .limit(EVENT_PAGE_LIMIT + 1);

  const page = rows.slice(0, EVENT_PAGE_LIMIT);
  const items = page.map(toDomainEvent);
  const nextCursor =
    rows.length > EVENT_PAGE_LIMIT && page.length > 0
      ? String(Number(page[page.length - 1]?.seq))
      : null;
  return cursorPageSchema(domainEventSchema).parse({ items, nextCursor });
}

/**
 * Global catch-up replay for ws reconnects (api-contracts.md §1 GET /events):
 * strictly seq-ordered, optionally filtered by aggregate, `after` is required by
 * the UI contract but tolerated as absent (returns from the log head).
 */
export async function listEvents(
  db: Db,
  options: { aggregateId?: string; after?: number | null },
): Promise<CursorPage<DomainEvent>> {
  const conditions = [];
  if (options.aggregateId) conditions.push(eq(events.aggregateId, options.aggregateId));
  if (options.after !== null && options.after !== undefined)
    conditions.push(gt(events.seq, options.after));

  const rows = await db
    .select()
    .from(events)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(events.seq))
    .limit(EVENT_CATCHUP_LIMIT + 1);

  const page = rows.slice(0, EVENT_CATCHUP_LIMIT);
  const items = page.map(toDomainEvent).map((item) => domainEventSchema.parse(item));
  const nextCursor =
    rows.length > EVENT_CATCHUP_LIMIT && page.length > 0
      ? String(Number(page[page.length - 1]?.seq))
      : null;
  return { items, nextCursor };
}

/** 404 guard for flight-scoped routes. */
export async function flightRowOrThrow(
  db: Db,
  flightId: string,
): Promise<typeof flights.$inferSelect> {
  const parsed = z.string().uuid().parse(flightId);
  const rows = await db.select().from(flights).where(eq(flights.id, parsed)).limit(1);
  const row = rows[0];
  if (!row) {
    throw new ApiError("NOT_FOUND", `flight ${flightId} not found`);
  }
  return row;
}
