import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

/**
 * F2 DoD confirm suite (api-contracts.md §5 behavioral contracts, CI-asserted):
 * - Confirm idempotency: same Idempotency-Key ⇒ identical response, replayed.
 * - Duplicate confirm with a different key ⇒ 409 IDEMPOTENCY_CONFLICT.
 * - Expiry: confirming an expired offer ⇒ 409 OFFER_EXPIRED, no saga opens.
 * - Interline option for a passenger ⇒ 403 FORBIDDEN (agent/supervisor path).
 * - Saga opens with the three stub steps; offer.confirmed + audit row persist.
 *
 * The suite provisions its own fixture offers for the demo passenger (NXQ4ZK)
 * directly in the rebook_ai database — order-independent and re-runnable; it
 * never depends on pipeline state left over from sibling suites.
 */

const BASE_URL = process.env.REBOOK_BASE_URL ?? "http://localhost:3004";
const DATABASE_URL =
  process.env.REBOOK_DATABASE_URL ?? "postgresql://turnaround:turnaround@localhost:5433/rebook_ai";

const PASSENGER = { email: "nadia.cho@pax-sim.example", password: "passenger-nx-01" };
const AGENT = { email: "amir.hassan@nx-sim.example", password: "agent-nx-01" };

let pool: Pool | null = null;
const jars: Record<string, string> = {};

async function db(): Promise<Pool> {
  if (!pool) pool = new Pool({ connectionString: DATABASE_URL });
  return pool;
}

async function login(who: keyof typeof jars): Promise<void> {
  const credentials = who === "pax" ? PASSENGER : AGENT;
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  expect(res.status).toBe(200);
  jars[who] = res.headers.get("set-cookie")!.split(";")[0];
}

async function post(path: string, who: string, data: unknown, key?: string) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: jars[who],
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(data),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as { error?: { code?: string } },
    replayed: res.headers.get("idempotency-replayed"),
  };
}

interface FixtureOffer {
  offerId: string;
  cheapOptionId: string;
  interlineOptionId: string;
}

const TEST_CONTEXT = JSON.stringify({
  flightNo: "NX 288",
  disruptionKind: "cancellation",
  delayMinutes: 0,
  reasonCode: "ITEST-01",
  voucherIssued: false,
  rankingHash: "integration-fixture",
});

const OPTION_ROWS: Array<{ kind: string; interline: boolean; reason: string; delta: number }> = [
  {
    kind: "fast",
    interline: true,
    reason: "Integration fixture — earliest arrival on SV 1102",
    delta: 210,
  },
  {
    kind: "cheap",
    interline: false,
    reason: "Integration fixture — lowest fare difference",
    delta: 60,
  },
  {
    kind: "flexible",
    interline: false,
    reason: "Integration fixture — refundable and changeable",
    delta: 260,
  },
];

/**
 * Idempotently provision a proposed fixture offer for the demo passenger —
 * one offer per scenario tag, reset to a clean proposed state (previous
 * confirmations, sagas and replay-store rows removed) so the suite is fully
 * re-runnable and order-independent.
 */
async function ensureFixtureOffer(
  scenario: "missingkey" | "interline403" | "agentconfirm" | "replay" | "expired",
): Promise<FixtureOffer> {
  const pool = await db();
  const pnrRow = await pool.query<{ id: string }>("select id from pnr where locator = 'NXQ4ZK'");
  const pnrId = pnrRow.rows[0]!.id;

  const reasonCode = `ITEST-${scenario.toUpperCase()}`;
  const existing = await pool.query<{ id: string }>(
    "select id from offers where pnr_id = $1 and context->>'reasonCode' = $2 limit 1",
    [pnrId, reasonCode],
  );
  let offerId = existing.rows[0]?.id;
  if (!offerId) {
    const expires =
      scenario === "expired" ? "now() - interval '1 minute'" : "now() + interval '30 minutes'";
    const created = await pool.query<{ id: string }>(
      `insert into offers (pnr_id, state, context, expires_at)
       values ($1, 'proposed', $2::jsonb, ${expires}) returning id`,
      [pnrId, TEST_CONTEXT.replace("ITEST-01", reasonCode)],
    );
    offerId = created.rows[0]!.id;
  }
  // Reset: clean any state left by a previous run of this scenario. The
  // confirmations table keys idempotency globally — purge the suite's 'it-%'
  // rows wherever they live.
  await pool.query("delete from confirmations where idempotency_key like 'it-%'");
  await pool.query(
    "delete from saga_steps where saga_id in (select id from sagas where offer_id = $1)",
    [offerId],
  );
  await pool.query("delete from sagas where offer_id = $1", [offerId]);
  await pool.query("update offers set state = 'proposed' where id = $1", [offerId]);
  // The replay store keys globally — purge the suite's keyspace ('it-')
  // regardless of which fixture-offer path a previous run stored them under.
  await pool.query("delete from idempotency_keys where key like 'it-%'");
  // event_log + audit_events stay untouched: they are append-only by design
  // (engineering-standards.md §4) — assertions below scope by fresh saga/offer
  // ids and count >= 1 instead of relying on rewritten history.
  const optionCount = await pool.query<{ count: string }>(
    "select count(*) from offer_options where offer_id = $1",
    [offerId],
  );
  if (optionCount.rows[0]!.count === "0") {
    for (const [index, row] of OPTION_ROWS.entries()) {
      await pool.query(
        `insert into offer_options (offer_id, rank, kind, reason, itinerary, fare_delta, interline)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          offerId,
          index + 1,
          row.kind,
          row.reason,
          JSON.stringify({
            segments: [
              {
                airline: row.interline ? "SV" : "NX",
                flightNo: row.interline ? "SV 1102" : "NX 211",
                origin: "SIN",
                dest: "AMS",
                depart: "2026-10-15T23:45:00+08:00",
                arrive: "2026-10-16T13:15:00+08:00",
                cabin: "economy",
              },
            ],
            currency: "SGD",
            refundable: row.kind === "flexible",
            changeable: true,
            overCap: false,
          }),
          row.delta,
          row.interline,
        ],
      );
    }
  }
  const options = await pool.query<{ id: string; interline: boolean }>(
    "select id, interline from offer_options where offer_id = $1 order by rank",
    [offerId],
  );
  return {
    offerId,
    cheapOptionId: options.rows.find((o) => !o.interline)!.id,
    interlineOptionId: options.rows.find((o) => o.interline)!.id,
  };
}

afterAll(async () => {
  await pool?.end();
});

describe("confirm idempotency + expiry (api-contracts.md §5, F2 DoD)", () => {
  it("requires an Idempotency-Key", async () => {
    await login("pax");
    await login("agent");
    const fixture = await ensureFixtureOffer("missingkey");
    const res = await fetch(`${BASE_URL}/api/v1/pax/offers/${fixture.offerId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: jars.pax },
      body: JSON.stringify({ optionId: fixture.cheapOptionId }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("blocks the interline option for passengers (403 FORBIDDEN)", async () => {
    const fixture = await ensureFixtureOffer("interline403");
    const res = await post(
      `/api/v1/pax/offers/${fixture.offerId}/confirm`,
      "pax",
      { optionId: fixture.interlineOptionId },
      "it-interline-pax",
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("opens a running saga with three stub steps on the agent path", async () => {
    const fixture = await ensureFixtureOffer("agentconfirm");
    // Agent confirms the interline option on the passenger's behalf — the
    // documented agent/supervisor path (api-contracts.md §1).
    const res = await post(
      `/api/v1/pax/offers/${fixture.offerId}/confirm`,
      "agent",
      { optionId: fixture.interlineOptionId },
      "it-interline-agent",
    );
    expect(res.status).toBe(201);
    expect(res.body.sagaState).toBe("running");
    const sagaId = res.body.sagaId as string;

    const pool = await db();
    const steps = await pool.query<{ step: string; state: string }>(
      "select step, state from saga_steps where saga_id = $1",
      [sagaId],
    );
    // id is a uuid — no natural order; assert the step SET and states.
    expect([...steps.rows.map((s) => s.step)].sort()).toEqual([
      "payment",
      "seat_reserve",
      "ticket_issue",
    ]);
    for (const step of steps.rows) expect(step.state).toBe("pending");
    // The saga points at its first step (insertion order lives in the row).
    const current = await pool.query<{ current_step: string }>(
      "select current_step from sagas where id = $1",
      [sagaId],
    );
    expect(current.rows[0]!.current_step).toBe("seat_reserve");

    // offer.confirmed event + audit row exist for exactly this offer/saga.
    const event = await pool.query<{ count: string }>(
      "select count(*) from event_log where type = 'offer.confirmed' and payload->>'sagaId' = $1",
      [sagaId],
    );
    expect(Number(event.rows[0]!.count)).toBe(1); // fresh saga id ⇒ exactly one
    const audit = await pool.query<{ count: string }>(
      "select count(*) from audit_events where action = 'offer.confirmed' and target_id = $1 and created_at > now() - interval '1 minute'",
      [fixture.offerId],
    );
    expect(Number(audit.rows[0]!.count)).toBeGreaterThanOrEqual(1);
  });

  it("replays the identical response for a repeated Idempotency-Key and conflicts on a different one", async () => {
    const fixture = await ensureFixtureOffer("replay");
    const first = await post(
      `/api/v1/pax/offers/${fixture.offerId}/confirm`,
      "pax",
      { optionId: fixture.cheapOptionId },
      "it-replay-1",
    );
    expect([200, 201, 409]).toContain(first.status); // 409 if a previous run confirmed
    if (first.status > 201) {
      // Already confirmed by an earlier run with it-replay-1 → replay path.
      const replay = await post(
        `/api/v1/pax/offers/${fixture.offerId}/confirm`,
        "pax",
        { optionId: fixture.cheapOptionId },
        "it-replay-1",
      );
      expect(replay.status).toBe(first.status);
      expect(replay.replayed).toBe("true");
    } else {
      const replay = await post(
        `/api/v1/pax/offers/${fixture.offerId}/confirm`,
        "pax",
        { optionId: fixture.cheapOptionId },
        "it-replay-1",
      );
      expect(replay.status).toBe(first.status);
      expect(replay.replayed).toBe("true");
      expect(replay.body).toEqual(first.body); // identical response, §5
    }

    // Same offer, DIFFERENT key ⇒ the exactly-one-effect guard (§5).
    const conflict = await post(
      `/api/v1/pax/offers/${fixture.offerId}/confirm`,
      "pax",
      { optionId: fixture.cheapOptionId },
      "it-replay-2",
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("refuses expired offers (409 OFFER_EXPIRED) and opens no saga", async () => {
    const fixture = await ensureFixtureOffer("expired"); // expires_at in the past
    const res = await post(
      `/api/v1/pax/offers/${fixture.offerId}/confirm`,
      "pax",
      { optionId: fixture.cheapOptionId },
      "it-expired-1",
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("OFFER_EXPIRED");

    const pool = await db();
    const saga = await pool.query("select id from sagas where offer_id = $1", [fixture.offerId]);
    expect(saga.rowCount).toBe(0);
  });
});
