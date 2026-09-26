import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createRedis } from "@aviation/db/redis";
import {
  queueSnapshotViewSchema,
  REBOOK_LIVE_CHANNEL,
  rebookLiveFrameSchema,
} from "@aviation/contracts";

/**
 * F2 DoD queue suite (milestones.md F2, data-model.md §3, architecture.md §4):
 * - RBAC: passenger 403, agent 200.
 * - Live update < 1 s after the event append (single-shot assert; the
 *   committed benchmark script measures p95 across N injections).
 * - Rebuild-from-PG: flushing the Redis projection ⇒ identical snapshot
 *   (Redis held only freshness — a flush never loses truth).
 * - Live frames validate against the zod frame contract.
 */

const BASE_URL = process.env.REBOOK_BASE_URL ?? "http://localhost:3004";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const PASSENGER = { email: "nadia.cho@pax-sim.example", password: "passenger-nx-01" };
const AGENT = { email: "amir.hassan@nx-sim.example", password: "agent-nx-01" };
const SUPERVISOR = { email: "grace.tan@nx-sim.example", password: "supervisor-nx-01" };

const jars: Record<string, string> = {};

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

async function get(path: string, who?: string) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: who ? { cookie: jars[who] } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}

afterAll(async () => {
  /* stack stays up for the sibling suites */
});

describe("live agent queue (PRD F-4, F2 DoD)", () => {
  it("enforces RBAC: anon 401, passenger 403, agent 200", async () => {
    await login("pax");
    await login("agent");
    const anon = await get("/api/v1/queue");
    expect(anon.status).toBe(401);
    const pax = await get("/api/v1/queue", "pax");
    expect(pax.status).toBe(403);
    const agent = await get("/api/v1/queue", "agent");
    expect(agent.status).toBe(200);
  });

  it("updates live < 1 s after the event append (single-shot assert)", async () => {
    await login("agent");
    await login("sup");
    const redis = await createRedis(REDIS_URL);
    try {
      const frames: Array<{ type: string; receivedAt: number }> = [];
      await redis.redis.subscribe(REBOOK_LIVE_CHANNEL, (raw) => {
        const parsed = rebookLiveFrameSchema.safeParse(JSON.parse(raw));
        if (parsed.success) frames.push({ type: parsed.data.type, receivedAt: Date.now() });
      });

      // Pick any still-scheduled flight — re-runs must stay deterministic.
      const pool = new Pool({
        connectionString:
          process.env.REBOOK_DATABASE_URL ??
          "postgresql://turnaround:turnaround@localhost:5433/rebook_ai",
      });
      const candidate = await pool.query<{ flight_no: string }>(
        `select f.flight_no from flights f
         where f.status = 'scheduled'
         order by (select count(*) from pnr_segments s where s.flight_no = f.flight_no) desc
         limit 1`,
      );
      const flightNo = candidate.rows[0]?.flight_no;
      expect(flightNo).toBeDefined();
      await pool.end();

      await new Promise((resolve) => setTimeout(resolve, 300));
      const t0 = Date.now();
      const inject = await fetch(`${BASE_URL}/api/v1/scenario/inject`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: jars.sup,
          "Idempotency-Key": `it-queue-live-${t0}`,
        },
        body: JSON.stringify({ scenario: "cancellation", flightNo }),
      });
      expect([201, 400]).toContain(inject.status);

      const deadline = Date.now() + 15_000;
      let latencyMs: number | null = null;
      while (Date.now() < deadline) {
        const frame = frames.find((f) => f.type === "queue.delta" && f.receivedAt >= t0);
        if (frame) {
          latencyMs = frame.receivedAt - t0;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(latencyMs).not.toBeNull();
      // F2 DoD: queue live update < 1 s after the append (bench:rebook-queue logs p95).
      expect(latencyMs!).toBeLessThan(1_000);
    } finally {
      await redis.close();
    }
  });

  it("rebuilds the identical snapshot from PG after a Redis flush", async () => {
    await login("agent");
    const before = await get("/api/v1/queue", "agent");
    expect(before.status).toBe(200);
    const snapshotBefore = queueSnapshotViewSchema.parse(before.body);
    expect(snapshotBefore.items.length).toBeGreaterThan(0); // a disruption is active

    // Flush ONLY the projection key (data-model.md §3 rb:queue:agent).
    const redis = await createRedis(REDIS_URL);
    try {
      await redis.redis.del("rb:queue:agent");
    } finally {
      await redis.close();
    }

    const after = await get("/api/v1/queue", "agent");
    expect(after.status).toBe(200);
    const snapshotAfter = queueSnapshotViewSchema.parse(after.body);

    // Same membership and hydration after the flush. Priorities legitimately
    // age (wait minutes accrue on rebuild), so the stable contract is the item
    // set + their PG-backed fields; order within one snapshot is score-sorted.
    const fields = (snapshot: typeof snapshotBefore) =>
      Object.fromEntries(
        snapshot.items.map((i) => [
          i.locator,
          { tier: i.tier, flightNo: i.flightNo, offerState: i.offerState },
        ]),
      );
    expect(Object.keys(fields(snapshotAfter)).sort()).toEqual(
      Object.keys(fields(snapshotBefore)).sort(),
    );
    expect(fields(snapshotAfter)).toEqual(fields(snapshotBefore));
    expect(snapshotAfter.waiting).toBe(snapshotBefore.waiting);
    expect(snapshotAfter.containmentPct).toBe(snapshotBefore.containmentPct);
  });
});
