import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { RedisClientType } from "@aviation/db/redis";

import { createRedis } from "@aviation/db/redis";

import { createOrchestratorDb, type OrchestratorDb } from "../src/db";
import { requestProposalForOffer, type WorkerDeps } from "../src/domain/proposal-request";

/**
 * F3 DoD — degrade honesty (D-10) end to end: with the provider OFF
 * (gateway null, LLM_PROVIDER=off) the orchestrator persists a proposal
 * labeled `source: "rules"`, provider `rules-engine`, zero tokens — and the
 * web surface (GET /api/v1/proposals/{id}, api-contracts.md §5 "never
 * unlabeled") serves exactly that badge pair. The mock-provider counterpart
 * (llm/mock badges through the same API) is asserted in
 * apps/rebook-ai/tests-integration/proposals.test.ts.
 */

const DATABASE_URL =
  process.env.REBOOK_DATABASE_URL ?? "postgresql://turnaround:turnaround@localhost:5433/rebook_ai";
const BASE_URL = process.env.REBOOK_BASE_URL ?? "http://localhost:3004";
const AGENT = { email: "amir.hassan@nx-sim.example", password: "agent-nx-01" };

let pool: Pool | null = null;
let db: OrchestratorDb;
let closeDb: () => Promise<void>;
let redis: RedisClientType;
let closeRedis: () => Promise<void>;

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

describe("degrade-to-rules proposals (F3 DoD, D-10)", () => {
  it("labels provider-off proposals rules end-to-end through the web API", async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const run = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const locator = `F3R${run.slice(0, 3)}`.toUpperCase().slice(0, 6);

    const pnr = await pool.query<{ id: string }>(
      `insert into pnr (locator, passenger_name, tier, fare_class, contact_handle, party_size, document)
       values ($1, 'Rules Tester', 'silver', 'Y', 'rules-test:sim', 1, '{}'::jsonb) returning id`,
      [locator],
    );
    const pnrId = pnr.rows[0]!.id;
    const offer = await pool.query<{ id: string }>(
      `insert into offers (pnr_id, state, context, expires_at)
       values ($1, 'proposed', $2::jsonb, now() + interval '30 minutes') returning id`,
      [
        pnrId,
        JSON.stringify({
          flightNo: "NX 288",
          disruptionKind: "cancellation",
          delayMinutes: 0,
          reasonCode: `RULES-${run}`,
          voucherIssued: false,
          rankingHash: "rules-test",
        }),
      ],
    );
    const offerId = offer.rows[0]!.id;
    await pool.query(
      `insert into offer_options (offer_id, rank, kind, reason, itinerary, fare_delta, interline)
       values ($1, 1, 'cheap', 'rules test', $2::jsonb, 60, false)`,
      [
        offerId,
        JSON.stringify({
          segments: [
            {
              airline: "NX",
              flightNo: "NX 211",
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

    // Provider OFF: the worker runs with gateway null (LLM_PROVIDER=off).
    const deps: WorkerDeps = {
      db,
      redis,
      metrics: { counters: {} },
      gateway: null,
      onLog: () => undefined,
    };
    const proposalId = crypto.randomUUID();
    await requestProposalForOffer(deps, { proposalId, pnrId, offerId });

    // Persisted honestly: rules / rules-engine, zero tokens, event appended.
    const row = await pool.query<{ source: string; provider: string; tokens: string }>(
      "select source, provider, tokens_in::text as tokens from proposals where id = $1",
      [proposalId],
    );
    expect(row.rows[0]!.source).toBe("rules");
    expect(row.rows[0]!.provider).toBe("rules-engine");
    expect(Number(row.rows[0]!.tokens)).toBe(0);
    const event = await pool.query<{ count: string }>(
      "select count(*) from event_log where type = 'proposal.created' and aggregate_id = $1 and payload->>'source' = 'rules'",
      [proposalId],
    );
    expect(Number(event.rows[0]!.count)).toBe(1);

    // End to end: the web surface serves the same rules badge (agent session).
    const login = await fetch(`${BASE_URL}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(AGENT),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const res = await fetch(`${BASE_URL}/api/v1/proposals/${proposalId}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const view = (await res.json()) as { source: string; provider: string; tokensIn: number };
    expect(view.source).toBe("rules");
    expect(view.provider).toBe("rules-engine");
    expect(view.tokensIn).toBe(0);

    // Cleanup the fixture booking (proposals/events are append-only).
    await pool.query("delete from pnr where id = $1", [pnrId]);
    await pool.query("delete from offers where id = $1", [offerId]);
  }, 30_000);
});
