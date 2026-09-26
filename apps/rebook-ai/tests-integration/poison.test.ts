import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

/**
 * F2 DoD poison-event suite (architecture.md §6, engineering-standards.md §6):
 * a malformed event must surface in the supervisor view with honest
 * processed=false + error note — never silently dropped.
 */

const BASE_URL = process.env.REBOOK_BASE_URL ?? "http://localhost:3004";
const DATABASE_URL =
  process.env.REBOOK_DATABASE_URL ?? "postgresql://turnaround:turnaround@localhost:5433/rebook_ai";

const SUPERVISOR = { email: "grace.tan@nx-sim.example", password: "supervisor-nx-01" };
const AGENT = { email: "amir.hassan@nx-sim.example", password: "agent-nx-01" };

let pool: Pool | null = null;

async function db(): Promise<Pool> {
  if (!pool) pool = new Pool({ connectionString: DATABASE_URL });
  return pool;
}

afterAll(async () => {
  await pool?.end();
});

describe("poison events (architecture.md §6, F2 DoD)", () => {
  it("surfaces a malformed event with processed=false and the error note", async () => {
    const login = await fetch(`${BASE_URL}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SUPERVISOR),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];

    // Inject a malformed flight.disrupted event straight into the log.
    const pool = await db();
    const inserted = await pool.query<{ id: string; aggregate_id: string }>(
      `insert into event_log (type, occurred_at, aggregate_type, aggregate_id, sequence, payload)
       values ('flight.disrupted', now(), 'flight', gen_random_uuid(), 1, '{"bad": true}'::jsonb)
       returning id, aggregate_id`,
    );
    const poisonId = inserted.rows[0]!.id;

    // The supervisor view must surface it once the tail recorded a failure.
    const deadline = Date.now() + 20_000;
    let surfaced: { id: string; attempts: number; processError: string } | null = null;
    while (Date.now() < deadline && !surfaced) {
      const res = await fetch(`${BASE_URL}/api/v1/admin/events?processed=false`, {
        headers: { cookie },
      });
      if (res.status === 200) {
        const body = (await res.json()) as { events: (typeof surfaced)[] };
        surfaced = body.events.find((e) => e.id === poisonId) ?? null;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(surfaced).not.toBeNull();
    expect(surfaced!.attempts).toBeGreaterThanOrEqual(1);
    expect(surfaced!.processError).toMatch(/invalid|expected|required|type/i);
  });

  it("is supervisor-only (agent 403, anon 401)", async () => {
    const anon = await fetch(`${BASE_URL}/api/v1/admin/events`);
    expect(anon.status).toBe(401);

    const agentLogin = await fetch(`${BASE_URL}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(AGENT),
    });
    const agentCookie = agentLogin.headers.get("set-cookie")!.split(";")[0];
    const agent = await fetch(`${BASE_URL}/api/v1/admin/events`, {
      headers: { cookie: agentCookie },
    });
    expect(agent.status).toBe(403);
  });
});
