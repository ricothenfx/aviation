import { eq, sql } from "drizzle-orm";

import type { Db } from "@aviation/db/client";
import {
  events,
  replanScenarios,
  type AggregateType,
  type ReplanScenarioRow,
} from "@aviation/db/schema";
import { ApiError, type Replan } from "@aviation/contracts";
import {
  CHAN_EVENTS,
  CHAN_REPLAN_CONTROL,
  replanResultKey,
  replanResultSchema,
  scenarioStartIso,
  type ReplanResult,
} from "@aviation/tiq-domain";
import type { RedisClientType } from "@aviation/db/redis";

import { newRequestId } from "@/lib/api/respond";
import { scenarioNowOrLast } from "@/lib/data/alerts";

/**
 * Replan flow (api-contracts.md §1, PRD F-4 — human-in-the-loop): propose
 * publishes on chan:replan:control and polls the engine's result key (the engine
 * decides from PostgreSQL only, architecture.md §2). Approve/reject are
 * user_action events on the replan aggregate; applying the plan is the engine's
 * job (task.rescheduled events the simulator adopts, architecture.md §3 step 5).
 */

const RESULT_TIMEOUT_MS = 8000;
const POLL_STEP_MS = 80;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function proposeReplan(redis: RedisClientType, flightId: string): Promise<Replan> {
  const requestId = newRequestId();
  await redis.publish(
    CHAN_REPLAN_CONTROL,
    JSON.stringify({ action: "propose", requestId, flightId }),
  );

  const deadline = Date.now() + RESULT_TIMEOUT_MS;
  let raw: string | null = null;
  while (Date.now() < deadline) {
    raw = await redis.get(replanResultKey(requestId));
    if (raw) break;
    await sleep(POLL_STEP_MS);
  }
  if (!raw) {
    throw new ApiError("INTERNAL", "replan engine did not answer in time");
  }
  let result: ReplanResult;
  try {
    result = replanResultSchema.parse(JSON.parse(raw));
  } catch {
    throw new ApiError("INTERNAL", "replan engine returned an invalid result");
  }
  if (!result.ok) {
    throw new ApiError(
      "REPLAN_INFEASIBLE",
      `${result.conflicts.length} constraint(s) unresolvable: ${result.conflicts.join(", ")}`,
      { conflicts: result.conflicts },
    );
  }
  return {
    id: result.replanId,
    flightId,
    status: "proposed",
    delta: result.delta,
    totalDelayMin: result.totalDelayMin,
    baselineDelayMin: result.baselineDelayMin,
    rationale: result.rationale,
    planHash: result.planHash,
    computedAt: new Date().toISOString(),
  };
}

export async function replanRowOrThrow(db: Db, replanId: string): Promise<ReplanScenarioRow> {
  const rows = await db
    .select()
    .from(replanScenarios)
    .where(eq(replanScenarios.id, replanId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiError("NOT_FOUND", `replan ${replanId} not found`);
  return row;
}

function requireProposed(row: ReplanScenarioRow): void {
  if (row.status !== "proposed") {
    throw new ApiError("VALIDATION_ERROR", `replan is already ${row.status}`);
  }
}

/** Append one user_action decision event; duplicates are conflicts, not no-ops. */
async function appendDecisionEvent(args: {
  db: Db;
  redis: RedisClientType;
  replanId: string;
  flightId: string;
  type: "replan.approved" | "replan.rejected";
  payload: Record<string, unknown>;
}): Promise<void> {
  const { db, redis, replanId, flightId, type, payload } = args;
  const occurredAt = await scenarioNowOrLast(db, redis).catch(() => scenarioStartIso());
  const sequence = await nextReplanSequence(db, replanId);
  const event = {
    id: `evt:replan:${replanId}:${sequence}`,
    type,
    occurredAt,
    aggregateId: replanId,
    aggregateType: "replan" as const,
    sequence,
    payload: { replanId, flightId, ...payload },
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
    throw new ApiError("IDEMPOTENCY_CONFLICT", "decision already recorded");
  }
  await redis.publish(CHAN_EVENTS, JSON.stringify(event));
}

export async function approveReplan(args: {
  db: Db;
  redis: RedisClientType;
  replanId: string;
  approvedBy: string;
}): Promise<{ replanId: string; status: "approved" }> {
  const { db, redis, replanId, approvedBy } = args;
  const row = await replanRowOrThrow(db, replanId);
  requireProposed(row);
  const cost = (row.costBreakdown ?? {}) as { totalDelayMin?: number };
  await appendDecisionEvent({
    db,
    redis,
    replanId,
    flightId: row.flightId,
    type: "replan.approved",
    payload: { approvedBy, appliedDelayMin: cost.totalDelayMin ?? 0 },
  });
  return { replanId, status: "approved" };
}

export async function rejectReplan(args: {
  db: Db;
  redis: RedisClientType;
  replanId: string;
  rejectedBy: string;
  reason: string;
}): Promise<{ replanId: string; status: "rejected" }> {
  const { db, redis, replanId, rejectedBy, reason } = args;
  const row = await replanRowOrThrow(db, replanId);
  requireProposed(row);
  await appendDecisionEvent({
    db,
    redis,
    replanId,
    flightId: row.flightId,
    type: "replan.rejected",
    payload: { rejectedBy, reason },
  });
  return { replanId, status: "rejected" };
}

async function nextReplanSequence(db: Db, replanId: string): Promise<number> {
  const rows = await db
    .select({ max: sql<number>`coalesce(max(${events.sequence}), 0)`.mapWith(Number) })
    .from(events)
    .where(eq(events.aggregateId, replanId));
  return (rows[0]?.max ?? 0) + 1;
}
