import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { RedisClientType } from "@aviation/db/redis";

import { createRedis } from "@aviation/db/redis";

import { createOrchestratorDb, type OrchestratorDb } from "../src/db";
import { advanceSaga, compensateSaga, recoverUnfinishedSagas } from "../src/domain/saga";
import { loadDisruptedPnrs } from "../src/domain/queue";

/**
 * F3 DoD — fulfillment saga executor (milestones.md, api-contracts.md §5):
 * - Idempotency: duplicate step delivery (double advanceSaga) ⇒ exactly one
 *   effect — the inventory counter decrements once, one booking.issued.
 * - Compensation: an injected payment failure (PSP_DECLINED marker) unwinds
 *   in reverse, restores the seats, reopens the offer honestly and returns
 *   the passenger to the queue (queue projection asserts membership).
 * - Crash-safe resume: a saga left mid-flight (seat done, rest pending) is
 *   finished by recovery from the persisted step state, with no double
 * effects.
 *
 * Runs against the compose "rebook" stack; suites provision their own saga
 * fixtures and are re-runnable (unique keys per run, append-only tables
 * asserted with count-by-fresh-id patterns).
 */

const DATABASE_URL =
  process.env.REBOOK_DATABASE_URL ?? "postgresql://turnaround:turnaround@localhost:5433/rebook_ai";

const FLIGHT = "NX 211"; // seeded inventory candidate with seats (24)
const ORIGIN_FLIGHT = "F3 SAGA"; // dedicated broken-flight fixture (no seed coupling)
const SEAT_QUERY = "select seats_left from inventory_seats where flight_no = $1";

let pool: Pool | null = null;
let db: OrchestratorDb;
let redis: RedisClientType;
let closeRedis: () => Promise<void>;
let closeDb: () => Promise<void>;

const deps = () => ({
  db,
  redis,
  metrics: { counters: {} as Record<string, number> },
  onLog: () => undefined,
});

interface TestSaga {
  sagaId: string;
  pnrId: string;
  offerId: string;
  optionId: string;
  locator: string;
}

let runCounter = 0;

async function openTestSaga(options: { markSeats?: number } = {}): Promise<TestSaga> {
  runCounter += 1;
  const pool = await getPool();
  const run = `${Date.now()}-${runCounter}`;
  const locator = `F3${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`.slice(0, 6);
  const pnr = await pool.query<{ id: string }>(
    `insert into pnr (locator, passenger_name, tier, fare_class, contact_handle, party_size, document)
     values ($1, 'Saga Tester', 'standard', 'Y', 'saga-test:sim', 2, '{}'::jsonb) returning id`,
    [locator],
  );
  const pnrId = pnr.rows[0]!.id;
  // Dedicated broken flight (status != scheduled) + its disruption event so
  // the queue projection counts this PNR — without touching demo flights.
  await pool.query(
    `insert into flights (airline, flight_no, origin, dest, sched_dep, sched_arr, aircraft, status)
     values ('NX', $1, 'SIN', 'AMS', now() + interval '2 days', now() + interval '2 days' + interval '12 hours', 'B763', 'cancelled')
     on conflict (flight_no) do update set status = 'cancelled'`,
    [ORIGIN_FLIGHT],
  );
  const flightId = (
    await pool.query<{ id: string }>("select id from flights where flight_no = $1", [ORIGIN_FLIGHT])
  ).rows[0]!.id;
  await pool.query(
    `insert into event_log (type, occurred_at, aggregate_type, aggregate_id, sequence, payload)
     values ('flight.disrupted', now(), 'flight', $1,
             coalesce((select max(sequence) + 1 from event_log e where e.aggregate_id = $1), 1),
             $2::jsonb)`,
    [
      flightId,
      JSON.stringify({
        flightNo: ORIGIN_FLIGHT,
        disruptionKind: "cancellation",
        delayMinutes: 0,
        reasonCode: "SAGA-TEST",
        affectedPnrs: 1,
      }),
    ],
  );
  // A disrupted booked segment puts the PNR on the (potential) queue.
  await pool.query(
    `insert into pnr_segments (pnr_id, airline, flight_no, flight_date, origin, dest, cabin, status)
     values ($1, 'NX', $2, now() + interval '2 days', 'SIN', 'AMS', 'economy', 'cancelled')`,
    [pnrId, ORIGIN_FLIGHT],
  );

  const offer = await pool.query<{ id: string }>(
    `insert into offers (pnr_id, state, context, expires_at)
     values ($1, 'confirmed', $2::jsonb, now() + interval '30 minutes') returning id`,
    [
      pnrId,
      JSON.stringify({
        flightNo: ORIGIN_FLIGHT,
        disruptionKind: "cancellation",
        delayMinutes: 0,
        reasonCode: `SAGA-${run}`,
        voucherIssued: false,
        rankingHash: "saga-test",
      }),
    ],
  );
  const offerId = offer.rows[0]!.id;
  const option = await pool.query<{ id: string }>(
    `insert into offer_options (offer_id, rank, kind, reason, itinerary, fare_delta, interline)
     values ($1, 1, 'fast', 'saga test', $2::jsonb, 60, false) returning id`,
    [
      offerId,
      JSON.stringify({
        segments: [
          {
            airline: "NX",
            flightNo: FLIGHT,
            origin: "SIN",
            dest: "AMS",
            depart: "2026-10-15T23:45:00+08:00",
            arrive: "2026-10-16T13:15:00+08:00",
            cabin: "economy",
          },
        ],
        currency: "SGD",
        refundable: false,
        changeable: true,
        overCap: false,
      }),
    ],
  );
  const optionId = option.rows[0]!.id;
  const saga = await pool.query<{ id: string }>(
    `insert into sagas (pnr_id, offer_id, state, current_step)
     values ($1, $2, 'running', 'seat_reserve') returning id`,
    [pnrId, offerId],
  );
  const sagaId = saga.rows[0]!.id;
  for (const step of ["seat_reserve", "payment", "ticket_issue"] as const) {
    const request =
      step === "seat_reserve"
        ? { flightNo: FLIGHT, seats: 2, simulated: true }
        : step === "payment"
          ? { amount: 60, currency: "SGD", simulated: true }
          : { simulated: true };
    await pool.query(
      `insert into saga_steps (saga_id, step, state, idempotency_key, request)
       values ($1, $2, 'pending', $3, $4::jsonb)`,
      [sagaId, step, `${sagaId}:${step}`, JSON.stringify(request)],
    );
  }
  if (options.markSeats !== undefined) {
    // Deterministic inventory for the suite (restored on teardown).
    await pool.query(
      `insert into inventory_seats (flight_no, seats_left) values ($1, $2)
       on conflict (flight_no) do update set seats_left = $2`,
      [FLIGHT, options.markSeats],
    );
  }
  return { sagaId, pnrId, offerId, optionId, locator };
}

async function getPool(): Promise<Pool> {
  if (!pool) pool = new Pool({ connectionString: DATABASE_URL });
  return pool;
}

async function sagaState(
  sagaId: string,
): Promise<{ state: string; current_step: string | null } | null> {
  const pool = await getPool();
  const res = await pool.query<{ state: string; current_step: string }>(
    "select state, current_step from sagas where id = $1",
    [sagaId],
  );
  return res.rows[0] ?? null;
}

beforeAll(async () => {
  const handle = createOrchestratorDb(DATABASE_URL);
  db = handle.db;
  closeDb = handle.close;
  const connection = await createRedis();
  redis = connection.redis;
  closeRedis = connection.close;
});

afterAll(async () => {
  await pool?.end();
  await closeDb();
  await closeRedis();
});

describe("saga executor (F3 DoD, ADR-0014 §4)", () => {
  it("completes with exactly one effect under duplicate step delivery", async () => {
    const fixture = await openTestSaga({ markSeats: 10 });
    const pool = await getPool();

    const seatsBefore = (await pool.query(SEAT_QUERY, [FLIGHT])).rows[0]!.seats_left as number;

    // Duplicate delivery: the confirm event handled twice, a manual re-drive,
    // whatever — advanceSaga must be exactly-once per step.
    const first = await advanceSaga(deps(), fixture.sagaId);
    const second = await advanceSaga(deps(), fixture.sagaId);
    expect(first).toBe("completed");
    expect(second).toBe("completed");

    const seatsAfter = (await pool.query(SEAT_QUERY, [FLIGHT])).rows[0]!.seats_left as number;
    expect(seatsBefore - seatsAfter).toBe(2); // party of 2, reserved ONCE

    const stepStates = await pool.query<{ step: string; state: string }>(
      "select step, state from saga_steps where saga_id = $1",
      [fixture.sagaId],
    );
    for (const row of stepStates.rows) expect(row.state).toBe("done");

    const issued = await pool.query<{ count: string }>(
      "select count(*) from event_log where type = 'booking.issued' and payload->>'sagaId' = $1",
      [fixture.sagaId],
    );
    expect(Number(issued.rows[0]!.count)).toBe(1);

    const boardingPass = await pool.query<{ boarding_pass_ref: string }>(
      "select response->>'boardingPassRef' as boarding_pass_ref from saga_steps where saga_id = $1 and step = 'ticket_issue'",
      [fixture.sagaId],
    );
    expect(boardingPass.rows[0]!.boarding_pass_ref).toMatch(/^BP-/);

    // Completed saga ⇒ the PNR has left the queue (served).
    const queue = await loadDisruptedPnrs(db);
    expect(queue.find((row) => row.pnrId === fixture.pnrId)).toBeUndefined();
  }, 30_000);

  it("compensates in reverse on injected payment failure and returns the passenger to the queue", async () => {
    const fixture = await openTestSaga({ markSeats: 10 });
    const pool = await getPool();

    const seatsBefore = (await pool.query(SEAT_QUERY, [FLIGHT])).rows[0]!.seats_left as number;

    // Inject the deterministic PSP failure on the payment step.
    await pool.query(
      "update saga_steps set request = request || '{\"simulateFailure\": true}'::jsonb where saga_id = $1 and step = 'payment'",
      [fixture.sagaId],
    );

    const terminal = await advanceSaga(deps(), fixture.sagaId);
    expect(terminal).toBe("compensated");

    // Reverse compensation: the seat hold is released, seats restored.
    const seatsAfter = (await pool.query(SEAT_QUERY, [FLIGHT])).rows[0]!.seats_left as number;
    expect(seatsAfter).toBe(seatsBefore);

    const stepStates = await pool.query<{ step: string; state: string }>(
      "select step, state from saga_steps where saga_id = $1 order by step",
      [fixture.sagaId],
    );
    const byStep = Object.fromEntries(stepStates.rows.map((r) => [r.step, r.state]));
    expect(byStep.seat_reserve).toBe("compensated");
    expect(byStep.payment).toBe("failed");
    expect(byStep.ticket_issue).toBe("pending"); // never reached

    const saga = await sagaState(fixture.sagaId);
    expect(saga!.state).toBe("compensated");

    // Honest reopen: the offer is proposed again and the compensation events
    // + failure event exist.
    const offer = await pool.query<{ state: string }>("select state from offers where id = $1", [
      fixture.offerId,
    ]);
    expect(offer.rows[0]!.state).toBe("proposed");
    const events = await pool.query<{ type: string }>(
      "select type from event_log where aggregate_id = $1 and type in ('saga.failed','saga.compensated')",
      [fixture.sagaId],
    );
    expect(events.rows.map((r) => r.type).sort()).toEqual(["saga.compensated", "saga.failed"]);

    // The passenger is back in the queue projection.
    const queue = await loadDisruptedPnrs(db);
    expect(queue.find((row) => row.pnrId === fixture.pnrId)).toBeDefined();

    // No booking was issued for a compensated saga.
    const issued = await pool.query<{ count: string }>(
      "select count(*) from event_log where type = 'booking.issued' and payload->>'sagaId' = $1",
      [fixture.sagaId],
    );
    expect(Number(issued.rows[0]!.count)).toBe(0);
  }, 30_000);

  it("recovers a saga killed mid-flight from persisted step state (crash-safe resume)", async () => {
    const fixture = await openTestSaga({ markSeats: 10 });
    const pool = await getPool();

    const seatsBefore = (await pool.query(SEAT_QUERY, [FLIGHT])).rows[0]!.seats_left as number;

    // Simulate the crash point: seat_reserve landed (persisted `done`), the
    // orchestrator died before payment. The steps after it stay pending.
    await pool.query(
      `update saga_steps set state = 'done', response = $2::jsonb
       where saga_id = $1 and step = 'seat_reserve'`,
      [
        fixture.sagaId,
        JSON.stringify({
          flightNo: FLIGHT,
          seatsReserved: 2,
          seatsLeftAfter: seatsBefore - 2,
          simulated: true,
        }),
      ],
    );
    await pool.query("update inventory_seats set seats_left = $2 where flight_no = $1", [
      FLIGHT,
      seatsBefore - 2,
    ]);

    // Recovery (boot or sweep) finishes the saga from the persisted state.
    await recoverUnfinishedSagas(deps());

    const saga = await sagaState(fixture.sagaId);
    expect(saga!.state).toBe("completed");
    const seatsAfter = (await pool.query(SEAT_QUERY, [FLIGHT])).rows[0]!.seats_left as number;
    expect(seatsBefore - seatsAfter).toBe(2); // the done step was NOT re-applied

    const issued = await pool.query<{ count: string }>(
      "select count(*) from event_log where type = 'booking.issued' and payload->>'sagaId' = $1",
      [fixture.sagaId],
    );
    expect(Number(issued.rows[0]!.count)).toBe(1);
  }, 30_000);

  it("exposes manual compensation for a failed saga (supervisor console path)", async () => {
    const fixture = await openTestSaga({ markSeats: 10 });
    const pool = await getPool();

    await pool.query(
      "update saga_steps set request = request || '{\"simulateFailure\": true}'::jsonb where saga_id = $1 and step = 'payment'",
      [fixture.sagaId],
    );
    await advanceSaga(deps(), fixture.sagaId); // lands failed→compensated

    // Manual compensation on an already-compensated saga is a no-op (idempotent).
    const state = await compensateSaga(deps(), fixture.sagaId, "supervisor-requested");
    expect(state).toBe("compensated");

    // A terminal saga cannot be compensated via the API path (SAGA_CONFLICT is
    // enforced by the web route; the executor itself is idempotent).
    const events = await pool.query<{ count: string }>(
      "select count(*) from event_log where aggregate_id = $1 and type = 'saga.compensated'",
      [fixture.sagaId],
    );
    expect(Number(events.rows[0]!.count)).toBe(1);
  }, 30_000);
});
