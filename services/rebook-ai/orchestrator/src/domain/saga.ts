import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { RedisClientType } from "@aviation/db/redis";

import { bookingIssuedPayloadSchema, type SagaStep } from "@aviation/contracts";

import type { OrchestratorDb } from "../db";
import {
  eventLog,
  inventorySeats,
  offers,
  offerOptions,
  pnr,
  pnrSegments,
  sagaSteps,
  sagas,
} from "../db";
import { appendEvent } from "./event-log";
import { offersUpdateFrame, publishFrame, queueDeltaFrame, sagaUpdateFrame } from "./frames";
import { createQueueProjector } from "./queue";

/**
 * Fulfillment saga executor (PRD F-6, architecture.md §3.2, ADR-0014 §4):
 * seat_reserve → payment → ticket_issue with compensable, exactly-once steps.
 *
 * Crash safety: every step's effect and its `done` transition commit in ONE
 * transaction keyed by the step's unique idempotency key (schema saga_steps),
 * so a crash either lands the whole step or none of it; re-driving from the
 * persisted step state (startup recovery + the periodic sweep) is therefore
 * idempotent — `done` steps are skipped, never re-executed (F3 DoD: duplicate
 * step delivery ⇒ exactly one effect).
 *
 * Deterministic simulated stubs (PRD §4: no real PSP/inventory):
 * - seat_reserve decrements the DB seats-left counter (inventory_seats) and
 *   fails with SEAT_UNAVAILABLE when inventory is short;
 * - payment fails with PSP_DECLINED when its request carries
 *   `simulateFailure: true` (injected failure, DoD compensation test);
 * - ticket_issue fails with TICKET_STOCK on the same marker and otherwise
 *   issues the boarding pass (demo beat): rebooked segment rows +
 *   `booking.issued` with a deterministic boarding-pass reference.
 *
 * Failure handling (architecture.md §6): transient errors retry with
 * backoff + jitter; deterministic failures fail the saga straight into
 * reverse compensation — the offer reopens honestly and the passenger
 * returns to the queue (queue rebuild, reason "compensation").
 */

const STEP_ORDER: SagaStep[] = ["seat_reserve", "payment", "ticket_issue"];

export interface SagaDeps {
  db: OrchestratorDb;
  redis: RedisClientType;
  metrics: { counters: Record<string, number> };
  onLog: (msg: string, fields?: Record<string, unknown>) => void;
}

export type SagaTerminal = "running" | "completed" | "failed" | "compensated";

/** Deterministic business failure — retrying cannot help (architecture §6). */
class StepFailure extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "StepFailure";
  }
}

interface StepRow {
  id: string;
  step: SagaStep;
  state: "pending" | "running" | "done" | "failed" | "compensated";
  idempotencyKey: string;
  request: unknown;
  response: unknown;
}

/** Documented option itinerary persisted in offer_options.itinerary (JSONB). */
interface StoredItinerary {
  segments: {
    airline: string;
    flightNo: string;
    origin: string;
    dest: string;
    depart: string;
    arrive: string;
    cabin: string;
  }[];
  currency: string;
}

interface SagaContext {
  saga: {
    id: string;
    pnrId: string;
    offerId: string;
    state: SagaTerminal;
    currentStep: string | null;
  };
  steps: Record<SagaStep, StepRow>;
  option: { id: string; fareDelta: number; itinerary: StoredItinerary } | null;
  partySize: number;
}

async function loadSagaContext(db: OrchestratorDb, sagaId: string): Promise<SagaContext | null> {
  const [saga] = await db
    .select({
      id: sagas.id,
      pnrId: sagas.pnrId,
      offerId: sagas.offerId,
      state: sagas.state,
      currentStep: sagas.currentStep,
    })
    .from(sagas)
    .where(eq(sagas.id, sagaId))
    .limit(1);
  if (!saga) return null;

  const stepRows = await db
    .select({
      id: sagaSteps.id,
      step: sagaSteps.step,
      state: sagaSteps.state,
      idempotencyKey: sagaSteps.idempotencyKey,
      request: sagaSteps.request,
      response: sagaSteps.response,
    })
    .from(sagaSteps)
    .where(eq(sagaSteps.sagaId, sagaId));
  const steps = {} as Record<SagaStep, StepRow>;
  for (const row of stepRows) steps[row.step] = row;

  const [party] = await db
    .select({ partySize: pnr.partySize })
    .from(pnr)
    .where(eq(pnr.id, saga.pnrId))
    .limit(1);

  const [optionRow] = await db
    .select({
      id: offerOptions.id,
      fareDelta: offerOptions.fareDelta,
      itinerary: offerOptions.itinerary,
    })
    .from(offerOptions)
    .where(eq(offerOptions.offerId, saga.offerId))
    .orderBy(offerOptions.rank)
    .limit(1);

  return {
    saga,
    steps,
    option: optionRow
      ? {
          id: optionRow.id,
          fareDelta: optionRow.fareDelta,
          itinerary: optionRow.itinerary as StoredItinerary,
        }
      : null,
    partySize: party?.partySize ?? 1,
  };
}

function stepRequest(ctx: SagaContext, step: SagaStep): Record<string, unknown> {
  const stored = (ctx.steps[step]?.request ?? {}) as Record<string, unknown>;
  return stored;
}

function primaryFlightNo(ctx: SagaContext): string {
  return ctx.option?.itinerary.segments[0]?.flightNo ?? "unknown";
}

/**
 * Deterministic boarding-pass reference (demo beat, demo-script.md):
 * derived from the saga id + new flight so replays stay identical.
 */
export function boardingPassRefFor(sagaId: string, flightNo: string): string {
  return `BP-${sagaId.replace(/-/g, "").slice(0, 8).toUpperCase()}-${flightNo.replace(/\s+/g, "")}`;
}

async function executeStep(
  deps: SagaDeps,
  ctx: SagaContext,
  step: SagaStep,
  row: StepRow,
  startedAt: number,
): Promise<void> {
  const { db } = deps;
  const key = row.idempotencyKey;
  const request = stepRequest(ctx, step);
  const latencyMs = (): number => Math.max(0, Date.now() - startedAt);

  if (step === "seat_reserve") {
    const flightNo = typeof request.flightNo === "string" ? request.flightNo : primaryFlightNo(ctx);
    const seats = typeof request.seats === "number" ? request.seats : ctx.partySize;
    const result = await db.transaction(async (tx) => {
      const decremented = await tx
        .update(inventorySeats)
        .set({ seatsLeft: sql`${inventorySeats.seatsLeft} - ${seats}`, updatedAt: new Date() })
        .where(
          and(eq(inventorySeats.flightNo, flightNo), sql`${inventorySeats.seatsLeft} >= ${seats}`),
        )
        .returning({ seatsLeft: inventorySeats.seatsLeft });
      if (decremented.length === 0) {
        throw new StepFailure(
          "SEAT_UNAVAILABLE",
          `seat_reserve: fewer than ${seats} seats left on ${flightNo}`,
        );
      }
      await tx
        .update(sagaSteps)
        .set({
          state: "done",
          response: {
            flightNo,
            seatsReserved: seats,
            seatsLeftAfter: decremented[0]!.seatsLeft,
            simulated: true,
          },
          updatedAt: new Date(),
        })
        .where(eq(sagaSteps.id, row.id));
      await tx
        .update(sagas)
        .set({ currentStep: nextStep(step), updatedAt: new Date() })
        .where(eq(sagas.id, ctx.saga.id));
      return decremented[0]!.seatsLeft;
    });
    deps.metrics.counters["rb_orchestrator_saga_steps_completed_total"] =
      (deps.metrics.counters["rb_orchestrator_saga_steps_completed_total"] ?? 0) + 1;
    await appendSagaStepEvent(deps, ctx, step, latencyMs());
    deps.onLog("saga_step_done", { sagaId: ctx.saga.id, step, seatsLeftAfter: result });
    return;
  }

  if (step === "payment") {
    if (request.simulateFailure === true) {
      throw new StepFailure("PSP_DECLINED", "payment: simulated PSP declined the charge");
    }
    const amount =
      typeof request.amount === "number" ? request.amount : (ctx.option?.fareDelta ?? 0);
    const currency =
      typeof request.currency === "string"
        ? request.currency
        : (ctx.option?.itinerary.currency ?? "SGD");
    await db.transaction(async (tx) => {
      await tx
        .update(sagaSteps)
        .set({
          state: "done",
          response: { chargeRef: `ch_${key}`, amount, currency, simulated: true },
          updatedAt: new Date(),
        })
        .where(eq(sagaSteps.id, row.id));
      await tx
        .update(sagas)
        .set({ currentStep: nextStep(step), updatedAt: new Date() })
        .where(eq(sagas.id, ctx.saga.id));
    });
    deps.metrics.counters["rb_orchestrator_saga_steps_completed_total"] =
      (deps.metrics.counters["rb_orchestrator_saga_steps_completed_total"] ?? 0) + 1;
    await appendSagaStepEvent(deps, ctx, step, latencyMs());
    deps.onLog("saga_step_done", { sagaId: ctx.saga.id, step, amount });
    return;
  }

  // ticket_issue — the final step completes the saga (boarding pass demo beat).
  if (request.simulateFailure === true) {
    throw new StepFailure("TICKET_STOCK", "ticket_issue: simulated ticket stock exhaustion");
  }
  const flightNo = primaryFlightNo(ctx);
  const boardingPassRef = boardingPassRefFor(ctx.saga.id, flightNo);
  const segments = ctx.option?.itinerary.segments ?? [];
  if (segments.length === 0) {
    throw new StepFailure("ITINERARY_MISSING", "ticket_issue: confirmed option has no itinerary");
  }
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(pnrSegments)
      .values(
        segments.map((segment) => ({
          pnrId: ctx.saga.pnrId,
          airline: segment.airline,
          flightNo: segment.flightNo,
          flightDate: new Date(segment.depart),
          origin: segment.origin,
          dest: segment.dest,
          cabin: segment.cabin,
          status: "confirmed" as const,
        })),
      )
      .returning({ id: pnrSegments.id });
    await tx
      .update(sagaSteps)
      .set({
        state: "done",
        response: {
          ticketRef: `tk_${key}`,
          boardingPassRef,
          insertedSegmentIds: inserted.map((s) => s.id),
          simulated: true,
        },
        updatedAt: new Date(),
      })
      .where(eq(sagaSteps.id, row.id));
    await tx
      .update(sagas)
      .set({ state: "completed", currentStep: null, updatedAt: new Date() })
      .where(eq(sagas.id, ctx.saga.id));
    await tx.update(offers).set({ state: "confirmed" }).where(eq(offers.id, ctx.saga.offerId));
    // booking.issued commits atomically with ticket_issue (§3.2: issued only
    // after the final step); payload validated before insert (api-contracts §2).
    const issuedPayload = bookingIssuedPayloadSchema.parse({
      sagaId: ctx.saga.id,
      pnrId: ctx.saga.pnrId,
      newFlightNo: flightNo,
      boardingPassRef,
    });
    await tx.insert(eventLog).values({
      type: "booking.issued",
      occurredAt: new Date(),
      aggregateType: "saga",
      aggregateId: ctx.saga.id,
      sequence: sql`(coalesce((select max(sequence) from event_log where aggregate_id = ${ctx.saga.id}), 0) + 1)`,
      payload: issuedPayload,
    });
  });
  deps.metrics.counters["rb_orchestrator_saga_steps_completed_total"] =
    (deps.metrics.counters["rb_orchestrator_saga_steps_completed_total"] ?? 0) + 1;
  deps.metrics.counters["rb_orchestrator_sagas_completed_total"] =
    (deps.metrics.counters["rb_orchestrator_sagas_completed_total"] ?? 0) + 1;
  await appendSagaStepEvent(deps, ctx, step, latencyMs());
  await publishSagaFrame(deps, ctx.saga, "completed", null);
  deps.onLog("saga_completed", { sagaId: ctx.saga.id, boardingPassRef });
}

function nextStep(step: SagaStep): SagaStep | null {
  const idx = STEP_ORDER.indexOf(step);
  return idx >= 0 && idx + 1 < STEP_ORDER.length ? STEP_ORDER[idx + 1]! : null;
}

async function appendSagaStepEvent(
  deps: SagaDeps,
  ctx: SagaContext,
  step: SagaStep,
  latencyMs: number,
): Promise<void> {
  await appendEvent(deps.db, {
    type: "saga.step.completed",
    aggregateType: "saga",
    aggregateId: ctx.saga.id,
    payload: { sagaId: ctx.saga.id, step, latencyMs: Math.max(0, Math.round(latencyMs)) },
  });
}

async function publishSagaFrame(
  deps: SagaDeps,
  saga: { id: string; pnrId: string },
  state: SagaTerminal,
  currentStep: string | null,
): Promise<void> {
  await publishFrame(
    deps.redis,
    sagaUpdateFrame({ pnrId: saga.pnrId, sagaId: saga.id, state, currentStep }, saga.id),
  );
}

async function failStep(
  deps: SagaDeps,
  ctx: SagaContext,
  step: SagaStep,
  row: StepRow,
  errorCode: string,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await tx
      .update(sagaSteps)
      .set({ state: "failed", response: { errorCode, simulated: true }, updatedAt: new Date() })
      .where(eq(sagaSteps.id, row.id));
    await tx
      .update(sagas)
      .set({ state: "failed", currentStep: step, updatedAt: new Date() })
      .where(eq(sagas.id, ctx.saga.id));
  });
  deps.metrics.counters["rb_orchestrator_saga_steps_failed_total"] =
    (deps.metrics.counters["rb_orchestrator_saga_steps_failed_total"] ?? 0) + 1;
  await appendEvent(deps.db, {
    type: "saga.failed",
    aggregateType: "saga",
    aggregateId: ctx.saga.id,
    payload: { sagaId: ctx.saga.id, step, errorCode },
  });
  await publishSagaFrame(deps, ctx.saga, "failed", step);
}

/** Compensation effect per completed step, in reverse order (§3.2/§6). */
async function compensateStep(
  deps: SagaDeps,
  ctx: SagaContext,
  step: SagaStep,
  row: StepRow,
): Promise<void> {
  const response = (row.response ?? {}) as Record<string, unknown>;
  await deps.db.transaction(async (tx) => {
    if (step === "seat_reserve") {
      const flightNo =
        typeof response.flightNo === "string" ? response.flightNo : primaryFlightNo(ctx);
      const seats =
        typeof response.seatsReserved === "number" ? response.seatsReserved : ctx.partySize;
      await tx
        .update(inventorySeats)
        .set({ seatsLeft: sql`${inventorySeats.seatsLeft} + ${seats}`, updatedAt: new Date() })
        .where(eq(inventorySeats.flightNo, flightNo));
    }
    if (step === "ticket_issue") {
      const ids = Array.isArray(response.insertedSegmentIds)
        ? (response.insertedSegmentIds as string[])
        : [];
      if (ids.length > 0) {
        await tx.delete(pnrSegments).where(inArray(pnrSegments.id, ids));
      }
    }
    // payment/seat effects are stubs — record the reversal on the step row.
    await tx
      .update(sagaSteps)
      .set({
        state: "compensated",
        response: {
          ...response,
          compensation:
            step === "payment"
              ? { refunded: true, refundRef: `rf_${row.idempotencyKey}` }
              : step === "seat_reserve"
                ? { released: true }
                : { voided: true, voidRef: `vd_${row.idempotencyKey}` },
        },
        updatedAt: new Date(),
      })
      .where(eq(sagaSteps.id, row.id));
  });
  deps.metrics.counters["rb_orchestrator_saga_steps_compensated_total"] =
    (deps.metrics.counters["rb_orchestrator_saga_steps_compensated_total"] ?? 0) + 1;
}

/**
 * Reverse compensation from persisted step state. Idempotent: compensated
 * steps are skipped, the offer reopens honestly (proposed) and the passenger
 * returns to the agent queue (rebuild with reason "compensation").
 */
export async function compensateSaga(
  deps: SagaDeps,
  sagaId: string,
  reason: string,
): Promise<SagaTerminal> {
  const ctx = await loadSagaContext(deps.db, sagaId);
  if (!ctx) throw new Error(`compensateSaga: unknown saga ${sagaId}`);
  if (ctx.saga.state === "compensated") return "compensated";

  const compensated: SagaStep[] = [];
  for (const step of [...STEP_ORDER].reverse()) {
    const row = ctx.steps[step];
    if (row && row.state === "done") {
      await compensateStep(deps, ctx, step, row);
      compensated.push(step);
    }
  }

  await deps.db.transaction(async (tx) => {
    // With at least one applied effect the saga lands `compensated`; a
    // zero-effect failure (first step never landed) stays honestly `failed`.
    if (compensated.length > 0) {
      await tx
        .update(sagas)
        .set({ state: "compensated", currentStep: null, updatedAt: new Date() })
        .where(eq(sagas.id, sagaId));
    }
    // Honest reopen (architecture §3.2): the passenger is disrupted again and
    // re-enters the queue; a later fresh confirm may open a new saga.
    await tx.update(offers).set({ state: "proposed" }).where(eq(offers.id, ctx.saga.offerId));
  });
  if (compensated.length > 0) {
    deps.metrics.counters["rb_orchestrator_sagas_compensated_total"] =
      (deps.metrics.counters["rb_orchestrator_sagas_compensated_total"] ?? 0) + 1;
    await appendEvent(deps.db, {
      type: "saga.compensated",
      aggregateType: "saga",
      aggregateId: sagaId,
      payload: { sagaId, compensatedSteps: compensated },
    });
  }
  await publishSagaFrame(deps, ctx.saga, compensated.length > 0 ? "compensated" : "failed", null);
  await publishFrame(
    deps.redis,
    offersUpdateFrame(
      { pnrId: ctx.saga.pnrId, offerId: ctx.saga.offerId, state: "proposed" },
      sagaId,
    ),
  );
  const projector = createQueueProjector(deps.db, deps.redis);
  const delta = await projector.rebuild();
  await publishFrame(deps.redis, queueDeltaFrame({ ...delta, reason: "compensation" }, sagaId));
  deps.onLog("saga_compensated", { sagaId, reason, steps: compensated });
  return "compensated";
}

const RETRY_BACKOFF_MS = 100;

async function sleepWithJitter(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms + Math.floor(Math.random() * ms * 0.5)));
}

/**
 * Drive a saga forward from its persisted step state (architecture §6:
 * "a stuck saga is re-driven from its persisted step state"). Idempotent —
 * safe to call on duplicate confirm events, after crashes, and from the
 * startup recovery + periodic sweep.
 */
export async function advanceSaga(deps: SagaDeps, sagaId: string): Promise<SagaTerminal> {
  const ctx = await loadSagaContext(deps.db, sagaId);
  if (!ctx) throw new Error(`advanceSaga: unknown saga ${sagaId}`);
  if (ctx.saga.state === "completed" || ctx.saga.state === "compensated") return ctx.saga.state;
  if (ctx.saga.state === "failed") {
    // Persisted failure (e.g. crash between failStep and compensation) —
    // finish the unwind deterministically.
    return compensateSaga(deps, sagaId, "resume-after-failure");
  }

  await publishSagaFrame(deps, ctx.saga, "running", ctx.saga.currentStep);
  for (const step of STEP_ORDER) {
    const row = ctx.steps[step];
    if (!row) continue; // steps are opened together at confirm; tolerate gaps
    if (row.state === "done") continue;
    if (row.state === "compensated") {
      return compensateSaga(deps, sagaId, "resume-after-compensation");
    }
    if (row.state === "failed") {
      return compensateSaga(deps, sagaId, "resume-after-failure");
    }

    // Transient errors retry with backoff + jitter; deterministic failures
    // go straight to compensation (architecture §6).
    const stepStartedAt = Date.now();
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        await executeStep(deps, ctx, step, row, stepStartedAt);
        break;
      } catch (err) {
        if (err instanceof StepFailure) {
          await failStep(deps, ctx, step, row, err.errorCode);
          return compensateSaga(deps, sagaId, err.errorCode);
        }
        if (attempts >= 2) {
          const code = err instanceof Error ? err.message.slice(0, 64) : "TRANSIENT";
          await failStep(deps, ctx, step, row, "RETRY_EXHAUSTED");
          deps.onLog("saga_step_retry_exhausted", { sagaId, step, err: code });
          return compensateSaga(deps, sagaId, "RETRY_EXHAUSTED");
        }
        deps.onLog("saga_step_retry", {
          sagaId,
          step,
          attempt: attempts,
          err: err instanceof Error ? err.message : String(err),
        });
        await sleepWithJitter(RETRY_BACKOFF_MS * attempts);
      }
    }
  }
  return "completed";
}

/** Startup recovery + periodic sweep target (architecture §6): re-drive. */
export async function recoverUnfinishedSagas(deps: SagaDeps): Promise<number> {
  const rows = await deps.db
    .select({ id: sagas.id })
    .from(sagas)
    .where(inArray(sagas.state, ["running", "failed"]))
    .orderBy(desc(sagas.createdAt))
    .limit(50);
  let driven = 0;
  for (const row of rows) {
    const terminal = await advanceSaga(deps, row.id);
    if (terminal === "completed" || terminal === "compensated") driven += 1;
  }
  return driven;
}
