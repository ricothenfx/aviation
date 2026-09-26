import { desc, eq, ne, sql } from "drizzle-orm";

import type { Db } from "@aviation/db/client";
import { alerts, events, type AlertRow } from "@aviation/db/schema";
import type { AggregateType } from "@aviation/db/schema";
import type { AlertProjection, DomainEvent } from "@aviation/contracts";
import { ApiError } from "@aviation/contracts";
import { CHAN_EVENTS, KEY_SCENARIO_STATE } from "@aviation/tiq-domain";
import type { RedisClientType } from "@aviation/db/redis";

/**
 * Alert lifecycle (api-contracts.md §1, data-model.md §2): coordinator+
 * acknowledge/resolve are user_action events on the alert aggregate; the
 * projection worker (realtime-gateway) maintains the `alerts` rows the board
 * rail and drawer read. Scenario time comes from the clock mirror — never the
 * client wall clock (architecture.md §4).
 */

const ACTIVE_LIMIT = 25;

export function toAlertProjection(row: AlertRow): AlertProjection {
  const detail = (row.detail ?? {}) as { leadTimeMin?: number | null };
  return {
    id: row.id,
    flightId: row.flightId,
    ruleId: row.ruleId,
    severity: row.severity,
    state: row.state,
    raisedAt: row.raisedAt.toISOString(),
    leadTimeMin: detail.leadTimeMin ?? null,
  };
}

/** Active alerts for the board rail (newest first, capped). */
export async function listActiveAlerts(db: Db): Promise<AlertProjection[]> {
  const rows = await db
    .select()
    .from(alerts)
    .where(ne(alerts.state, "resolved"))
    .orderBy(desc(alerts.raisedAt))
    .limit(ACTIVE_LIMIT);
  return rows.map(toAlertProjection);
}

export async function alertRowOrThrow(db: Db, alertId: string): Promise<AlertRow> {
  const rows = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
  const row = rows[0];
  if (!row) throw new ApiError("NOT_FOUND", `alert ${alertId} not found`);
  return row;
}

/**
 * Scenario-time stamp for user events: the running clock's reading, else the
 * latest logged instant, else wall time (idle day — nothing to ack anyway).
 */
export async function scenarioNowOrLast(db: Db, redis: RedisClientType): Promise<string> {
  const state = await redis.hGetAll(KEY_SCENARIO_STATE);
  if (state.status === "running" && state.scenarioNow) return state.scenarioNow;
  const rows = await db
    .select({ occurredAt: events.occurredAt })
    .from(events)
    .orderBy(sql`${events.seq} desc`)
    .limit(1);
  return rows[0]?.occurredAt.toISOString() ?? new Date().toISOString();
}

export async function appendAlertLifecycle(args: {
  db: Db;
  redis: RedisClientType;
  alert: AlertRow;
  kind: "acknowledged" | "resolved";
  actorEmail: string;
  note?: string;
}): Promise<DomainEvent> {
  const { db, redis, alert, kind, actorEmail, note } = args;
  if (kind === "acknowledged" && alert.state !== "raised") {
    throw new ApiError("VALIDATION_ERROR", `alert is ${alert.state}, expected raised`);
  }
  if (kind === "resolved" && alert.state === "resolved") {
    throw new ApiError("VALIDATION_ERROR", "alert is already resolved");
  }

  const occurredAt = await scenarioNowOrLast(db, redis);
  const sequence = await nextSequence(db, alert.id);
  const event: DomainEvent = {
    id: `evt:alert:${alert.id}:${sequence}`,
    type: kind === "acknowledged" ? "alert.acknowledged" : "alert.resolved",
    occurredAt,
    aggregateId: alert.id,
    aggregateType: "alert",
    sequence,
    payload: {
      alertId: alert.id,
      flightId: alert.flightId,
      ruleId: alert.ruleId,
      severity: alert.severity,
      leadTimeMin: null,
      actor: actorEmail,
      ...(note ? { note } : {}),
    },
  };

  const inserted = await db
    .insert(events)
    .values({
      id: event.id,
      aggregateId: event.aggregateId,
      aggregateType: event.aggregateType as AggregateType,
      type: event.type,
      sequence: event.sequence,
      occurredAt: new Date(event.occurredAt),
      payload: event.payload,
      producer: "user_action",
    })
    .onConflictDoNothing()
    .returning({ seq: events.seq });
  if (inserted.length === 0) {
    throw new ApiError("IDEMPOTENCY_CONFLICT", "alert lifecycle event already recorded");
  }
  await redis.publish(CHAN_EVENTS, JSON.stringify(event));
  return event;
}

async function nextSequence(db: Db, aggregateId: string): Promise<number> {
  const rows = await db
    .select({ max: sql<number>`coalesce(max(${events.sequence}), 0)`.mapWith(Number) })
    .from(events)
    .where(eq(events.aggregateId, aggregateId));
  return (rows[0]?.max ?? 0) + 1;
}
