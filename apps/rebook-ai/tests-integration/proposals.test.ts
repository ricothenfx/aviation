import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

/**
 * F3 DoD suites driven through the real web surface (api-contracts.md §1/§5):
 * - Agent requests a proposal → trace completeness (every tool call persists
 *   inputs/outputs + token usage) and `llm`/`mock` honesty badges (D-10).
 * - Propose-only invariant: `proposal.created` mutates zero booking state;
 *   only approval applies via the shared saga path (integration test).
 * - RBAC: passenger 403; interline/over-cap approve requires supervisor
 *   (403 for agent); reject carries a mandatory note.
 * - Audit completeness: approve/reject each append an audit row.
 *
 * Fixtures are provisioned idempotently for the demo passenger (NXQ4ZK) —
 * re-runnable and order-independent (F2 confirm-suite pattern).
 */

const BASE_URL = process.env.REBOOK_BASE_URL ?? "http://localhost:3004";
const DATABASE_URL =
  process.env.REBOOK_DATABASE_URL ?? "postgresql://turnaround:turnaround@localhost:5433/rebook_ai";

const PASSENGER = { email: "nadia.cho@pax-sim.example", password: "passenger-nx-01" };
const AGENT = { email: "amir.hassan@nx-sim.example", password: "agent-nx-01" };
const SUPERVISOR = { email: "grace.tan@nx-sim.example", password: "supervisor-nx-01" };
const LOCATOR = "NXQ4ZK";

let pool: Pool | null = null;
const jars: Record<string, string> = {};

async function db(): Promise<Pool> {
  if (!pool) pool = new Pool({ connectionString: DATABASE_URL });
  return pool;
}

async function login(who: keyof typeof jars): Promise<void> {
  const credentials = who === "pax" ? PASSENGER : who === "agent" ? AGENT : SUPERVISOR;
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  expect(res.status).toBe(200);
  jars[who] = res.headers.get("set-cookie")!.split(";")[0];
}

interface ApiResult {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-side JSON envelope
}

async function api(
  method: string,
  path: string,
  who: string | null,
  data?: unknown,
  key?: string,
): Promise<ApiResult> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(who ? { cookie: jars[who] } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const TEST_CONTEXT = JSON.stringify({
  flightNo: "NX 288",
  disruptionKind: "cancellation",
  delayMinutes: 0,
  reasonCode: "ITEST-F3",
  voucherIssued: false,
  rankingHash: "integration-fixture-f3",
});

// Distinct arrival times mirror the real inventory: the agent's deterministic
// recommendation is the EARLIEST arrival (SV 1102, interline) — the supervisor
// gate fixture. NX 208 is the over-cap flexible option.
const OPTION_ROWS = [
  {
    kind: "fast",
    interline: true,
    overCap: false,
    delta: 210,
    flightNo: "SV 1102",
    depart: "2026-10-15T11:30:00+08:00",
    arrive: "2026-10-16T01:00:00+08:00",
  },
  {
    kind: "cheap",
    interline: false,
    overCap: false,
    delta: 60,
    flightNo: "NX 211",
    depart: "2026-10-15T23:45:00+08:00",
    arrive: "2026-10-16T13:15:00+08:00",
  },
  {
    kind: "flexible",
    interline: false,
    overCap: true,
    delta: 900,
    flightNo: "NX 208",
    depart: "2026-10-15T12:40:00+08:00",
    arrive: "2026-10-16T02:10:00+08:00",
  },
];

interface Fixture {
  offerId: string;
  options: { id: string; kind: string; interline: boolean; overCap: boolean }[];
}

/** Idempotently provision a fresh proposed offer for the demo passenger. */
async function ensureFixtureOffer(scenario: string): Promise<Fixture> {
  const pool = await db();
  const pnrRow = await pool.query<{ id: string }>("select id from pnr where locator = $1", [
    LOCATOR,
  ]);
  const pnrId = pnrRow.rows[0]!.id;

  const reasonCode = `ITEST-F3-${scenario.toUpperCase()}`;
  // The proposal route targets the PNR's NEWEST proposed offer — wipe this
  // suite's prior fixtures so the freshly created offer is deterministically
  // the target, run after run (cascades clean options + confirmations).
  await pool.query(
    "delete from offers where pnr_id = $1 and context->>'reasonCode' like 'ITEST-F3-%'",
    [pnrId],
  );
  const created = await pool.query<{ id: string }>(
    `insert into offers (pnr_id, state, context, expires_at)
     values ($1, 'proposed', $2::jsonb, now() + interval '30 minutes') returning id`,
    [pnrId, TEST_CONTEXT.replace("ITEST-F3", reasonCode)],
  );
  const offerId = created.rows[0]!.id;
  for (const [index, row] of OPTION_ROWS.entries()) {
    await pool.query(
      `insert into offer_options (offer_id, rank, kind, reason, itinerary, fare_delta, interline)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        offerId,
        index + 1,
        row.kind,
        `F3 fixture ${row.kind}`,
        JSON.stringify({
          segments: [
            {
              airline: row.flightNo.slice(0, 2),
              flightNo: row.flightNo,
              origin: "SIN",
              dest: "AMS",
              depart: row.depart,
              arrive: row.arrive,
              cabin: "economy",
            },
          ],
          currency: "SGD",
          refundable: row.kind === "flexible",
          changeable: true,
          overCap: row.overCap,
        }),
        row.delta,
        row.interline,
      ],
    );
  }
  await pool.query("update offers set state = 'proposed' where id = $1", [offerId]);
  const options = await pool.query<{
    id: string;
    interline: boolean;
    itinerary: { overCap?: boolean };
  }>("select id, interline, itinerary from offer_options where offer_id = $1 order by rank", [
    offerId,
  ]);
  return {
    offerId: offerId!,
    options: options.rows.map((row) => ({
      id: row.id,
      kind: OPTION_ROWS[options.rows.indexOf(row)]!.kind,
      interline: row.interline,
      overCap: row.itinerary?.overCap === true,
    })),
  };
}

async function bookingStateCounts(offerId: string): Promise<{
  confirmations: number;
  sagas: number;
  rebookedSegments: number;
}> {
  const pool = await db();
  const confirmations = await pool.query<{ count: string }>(
    "select count(*) from confirmations where offer_id = $1",
    [offerId],
  );
  const sagas = await pool.query<{ count: string }>(
    "select count(*) from sagas where offer_id = $1",
    [offerId],
  );
  const rebooked = await pool.query<{ count: string }>(
    `select count(*) from pnr_segments s where s.pnr_id = (select pnr_id from offers where id = $1)
     and s.status = 'rebooked'`,
    [offerId],
  );
  return {
    confirmations: Number(confirmations.rows[0]!.count),
    sagas: Number(sagas.rows[0]!.count),
    rebookedSegments: Number(rebooked.rows[0]!.count),
  };
}

/** Poll GET /proposals/{id} until the orchestrator persists it (or timeout). */
async function pollProposal(proposalId: string, timeoutMs = 20_000): Promise<ApiResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api("GET", `/api/v1/proposals/${proposalId}`, "agent");
    if (res.status === 200) return res;
    if (Date.now() > deadline) return res;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

afterAll(async () => {
  await pool?.end();
});

describe("agent-loop proposals (F3 DoD, api-contracts.md §1/§5)", () => {
  it("requires the agent role (passenger 403, anon 401)", async () => {
    await login("pax");
    await login("agent");
    const fixture = await ensureFixtureOffer("rbac");
    const paxRes = await api(
      "POST",
      `/api/v1/pnr/${LOCATOR}/proposal`,
      "pax",
      undefined,
      "it-f3-pax-req",
    );
    expect(paxRes.status).toBe(403);
    const anonRes = await fetch(`${BASE_URL}/api/v1/pnr/${LOCATOR}/proposal`, {
      method: "POST",
      headers: { "Idempotency-Key": "it-f3-anon" },
    });
    expect(anonRes.status).toBe(401);
    // The PNR itself stays agent-only too.
    const detail = await api("GET", `/api/v1/pnr/${LOCATOR}`, "agent");
    expect(detail.status).toBe(200);
    void fixture;
  });

  it("produces a traced, badged proposal and mutates no booking state (propose-only)", async () => {
    const fixture = await ensureFixtureOffer("loop");
    const before = await bookingStateCounts(fixture.offerId);

    const requested = await api(
      "POST",
      `/api/v1/pnr/${LOCATOR}/proposal`,
      "agent",
      undefined,
      `it-f3-req-${scenarioStamp()}`,
    );
    expect(requested.status).toBe(201);
    const proposalId = requested.body.proposalId as string;

    const view = await pollProposal(proposalId);
    expect(view.status).toBe(200);
    expect(view.body.source).toBe("llm"); // compose default LLM_PROVIDER=mock
    expect(view.body.provider).toBe("mock");
    expect(view.body.state).toBe("proposed");

    // Trace completeness (F3 DoD): every tool call persists inputs/outputs;
    // the loop is search → (price + policy)×options → draft.
    const tools = (view.body.trace as { tool: string }[]).map((call) => call.tool);
    expect(tools[0]).toBe("search_routings");
    expect(tools.at(-1)).toBe("draft_proposal");
    expect(tools.filter((t) => t === "check_policy").length).toBe(fixture.options.length);
    for (const call of view.body.trace as Record<string, unknown>[]) {
      expect(Object.keys(call.input as object).length).toBeGreaterThan(0);
      expect(Object.keys(call.output as object).length).toBeGreaterThan(0);
    }
    expect(view.body.tokensIn).toBeGreaterThan(0);
    expect(view.body.tokensOut).toBeGreaterThan(0);
    expect(view.body.rationale.length).toBeGreaterThan(0);

    // The mock's grounded draft recommends the earliest-arrival option (fast,
    // interline) — the supervisor gate must be surfaced.
    expect(view.body.recommendedOptionId).toBe(fixture.options.find((o) => o.kind === "fast")!.id);
    expect(view.body.requiresSupervisor.required).toBe(true);

    // Propose-only invariant: zero booking mutations from creation.
    const after = await bookingStateCounts(fixture.offerId);
    expect(after).toEqual(before);
    expect(after.confirmations).toBe(0);
    expect(after.sagas).toBe(0);
  });

  it("gates supervisor elevation: agent approve 403 on interline, supervisor approves via the saga path", async () => {
    await login("supervisor");
    const fixture = await ensureFixtureOffer("gate");
    const requested = await api(
      "POST",
      `/api/v1/pnr/${LOCATOR}/proposal`,
      "agent",
      undefined,
      `it-f3-req-${scenarioStamp()}`,
    );
    expect(requested.status).toBe(201);
    const proposalId = requested.body.proposalId as string;
    await pollProposal(proposalId);

    // Agent (amir) hits the elevation gate on the interline recommendation.
    const agentApprove = await api(
      "POST",
      `/api/v1/proposals/${proposalId}/approve`,
      "agent",
      {},
      `it-f3-apr-${scenarioStamp()}`,
    );
    expect(agentApprove.status).toBe(403);
    expect(agentApprove.body.error.code).toBe("FORBIDDEN");

    // Supervisor approves — the proposal rides the ONE saga path.
    const approve = await api(
      "POST",
      `/api/v1/proposals/${proposalId}/approve`,
      "supervisor",
      { note: "partner rebooking confirmed by phone" },
      `it-f3-apr-${scenarioStamp()}`,
    );
    expect(approve.status).toBe(201);
    expect(approve.body.state).toBe("approved");
    expect(approve.body.sagaId).toBeTruthy();

    const pool = await db();
    const counts = await bookingStateCounts(fixture.offerId);
    expect(counts.confirmations).toBe(1);
    expect(counts.sagas).toBe(1);
    const steps = await pool.query<{ step: string; state: string }>(
      "select step, state from saga_steps where saga_id = $1",
      [approve.body.sagaId],
    );
    expect(steps.rowCount).toBe(3);

    // Audit completeness: proposal.approved AND offer.confirmed rows exist.
    const audits = await pool.query<{ action: string; count: string }>(
      `select action, count(*) from audit_events
       where target_id = $1 and created_at > now() - interval '2 minutes'
       group by action`,
      [proposalId],
    );
    const actions = Object.fromEntries(audits.rows.map((r) => [r.action, Number(r.count)]));
    expect(actions["proposal.approved"]).toBeGreaterThanOrEqual(1);

    const offerAudit = await pool.query<{ count: string }>(
      `select count(*) from audit_events where action = 'offer.confirmed'
       and details->>'sagaId' = $1 and created_at > now() - interval '2 minutes'`,
      [approve.body.sagaId],
    );
    expect(Number(offerAudit.rows[0]!.count)).toBeGreaterThanOrEqual(1);

    // Deciding again is rejected honestly.
    const again = await api("POST", `/api/v1/proposals/${proposalId}/approve`, "supervisor", {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("PROPOSAL_NOT_PENDING");
  });

  it("rejects with a mandatory note, appends the audit row, and mutates nothing else", async () => {
    const fixture = await ensureFixtureOffer("reject");
    const before = await bookingStateCounts(fixture.offerId);
    const requested = await api(
      "POST",
      `/api/v1/pnr/${LOCATOR}/proposal`,
      "agent",
      undefined,
      `it-f3-req-${scenarioStamp()}`,
    );
    const proposalId = requested.body.proposalId as string;
    await pollProposal(proposalId);

    const missingNote = await api("POST", `/api/v1/proposals/${proposalId}/reject`, "agent", {});
    expect(missingNote.status).toBe(400);

    const reject = await api(
      "POST",
      `/api/v1/proposals/${proposalId}/reject`,
      "agent",
      { note: "customer prefers the later flexible option" },
      `it-f3-rej-${scenarioStamp()}`,
    );
    expect(reject.status).toBe(201);
    expect(reject.body.state).toBe("rejected");

    const pool = await db();
    const audit = await pool.query<{ count: string }>(
      `select count(*) from audit_events where action = 'proposal.rejected'
       and target_id = $1 and created_at > now() - interval '2 minutes'`,
      [proposalId],
    );
    expect(Number(audit.rows[0]!.count)).toBeGreaterThanOrEqual(1);
    const event = await pool.query<{ count: string }>(
      "select count(*) from event_log where type = 'proposal.rejected' and aggregate_id = $1",
      [proposalId],
    );
    expect(Number(event.rows[0]!.count)).toBe(1);
    expect(await bookingStateCounts(fixture.offerId)).toEqual(before);
  });

  it("serves proposals through the PNR detail view (console surface)", async () => {
    await ensureFixtureOffer("detail");
    const detail = await api("GET", `/api/v1/pnr/${LOCATOR}`, "agent");
    expect(detail.status).toBe(200);
    expect(Array.isArray(detail.body.proposals)).toBe(true);
    expect(detail.body.proposals.length).toBeGreaterThanOrEqual(1);
    for (const proposal of detail.body.proposals) {
      expect(proposal.source).toBeDefined();
      expect(Array.isArray(proposal.trace)).toBe(true);
    }
  });
});

let stamp = 0;
function scenarioStamp(): string {
  stamp += 1;
  return `${Date.now()}-${stamp}`;
}
