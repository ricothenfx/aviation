import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Admin ingest API (api-contracts.md §1 Admin/Ingest, PRD US-10; contract
 * completion deferred from F3/F4 and treated as in-scope for F5 per the
 * milestone-report doc-gap note). Drives the PUBLIC app endpoints:
 * - RBAC: reviewer+ only, ladder enforced server-side.
 * - Idempotent re-ingest through the API (FR-5 evidence chain).
 * - 409 INGEST_IN_PROGRESS while the ai-service advisory lock is held
 *   (deterministic: the test holds lock 932_001 — mro_ai/ingest.py
 *   INGEST_LOCK_KEY — on its own connection).
 */

const BASE_URL = process.env.MRO_BASE_URL ?? "http://localhost:3003";

const REVIEWER = { email: "wei.lim@mro-sim.example", password: "reviewer-nx-01" };
const ENGINEER = { email: "siti.rahayu@mro-sim.example", password: "engineer-nx-01" };
const VIEWER = { email: "tom.ng@mro-sim.example", password: "viewer-nx-01" };

/** Mirrors mro_ai/ingest.py INGEST_LOCK_KEY — keep in lockstep. */
const INGEST_LOCK_KEY = 932_001;

const pool = new pg.Pool({
  connectionString:
    process.env.MRO_DATABASE_URL ?? "postgresql://turnaround:turnaround@localhost:5433/mro_copilot",
  max: 2,
});

afterAll(async () => {
  await pool.end();
});

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("login returned no session cookie");
  return setCookie.split(";")[0];
}

async function postIngest(
  cookie: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/ingest`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function getRuns(cookie: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/ingest/runs`, { headers: { Cookie: cookie } });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

let reviewerCookie: string;
let engineerCookie: string;
let viewerCookie: string;

beforeAll(async () => {
  reviewerCookie = await login(REVIEWER.email, REVIEWER.password);
  engineerCookie = await login(ENGINEER.email, ENGINEER.password);
  viewerCookie = await login(VIEWER.email, VIEWER.password);
});

describe("POST /api/v1/admin/ingest RBAC (api-contracts §1)", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/admin/ingest`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects viewer with 403 FORBIDDEN", async () => {
    const { status, body } = await postIngest(viewerCookie);
    expect(status).toBe(403);
    expect((body.error as { code?: string })?.code).toBe("FORBIDDEN");
  });

  it("rejects engineer with 403 FORBIDDEN", async () => {
    const { status, body } = await postIngest(engineerCookie);
    expect(status).toBe(403);
    expect((body.error as { code?: string })?.code).toBe("FORBIDDEN");
  });
});

describe("GET /api/v1/admin/ingest/runs (US-10 ingest status)", () => {
  it("rejects viewer and engineer with 403", async () => {
    expect((await getRuns(viewerCookie)).status).toBe(403);
    expect((await getRuns(engineerCookie)).status).toBe(403);
  });

  it("lists ingest run reports for the reviewer with full evidence fields", async () => {
    const { status, body } = await getRuns(reviewerCookie);
    expect(status).toBe(200);
    const runs = body.runs as Array<Record<string, unknown>>;
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBeGreaterThan(0); // compose boot ingests at startup
    for (const run of runs.slice(0, 3)) {
      expect(String(run.corpusDigest)).toMatch(/^[0-9a-f]{64}$/);
      expect(run.embeddingModel).toBe("mock-hashed-ngram-384");
      expect(typeof run.chunksNew).toBe("number");
      expect(typeof run.chunksUnchanged).toBe("number");
      expect(typeof run.durationMs).toBe("number");
      expect(run.status).toBe("completed");
      expect(typeof run.createdAt).toBe("string");
    }
    expect(body.nextCursor).toBeNull();
  });
});

describe("POST /api/v1/admin/ingest idempotency through the public API (FR-5)", () => {
  it("re-ingests with a no-op report: new/changed 0, identical corpus digest", async () => {
    const before = await pool.query<{ corpus_digest: string }>(
      "select corpus_digest from ingest_runs order by created_at desc limit 1",
    );

    const first = await postIngest(reviewerCookie);
    expect(first.status).toBe(200);
    const report = first.body as {
      corpusDigest: string;
      embeddingModel: string;
      manualsTouched: number;
      chunks: { new: number; changed: number; unchanged: number; removed: number };
      durationMs: number;
      status: string;
    };
    expect(report.corpusDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.status).toBe("completed");

    const second = await postIngest(reviewerCookie);
    expect(second.status).toBe(200);
    const rerun = second.body as typeof report;
    expect(rerun.corpusDigest).toBe(report.corpusDigest);
    expect(rerun.embeddingModel).toBe(report.embeddingModel);
    expect(rerun.manualsTouched).toBe(report.manualsTouched);
    // Every corpus chunk is known after the first run: new/changed 0 and
    // unchanged totals the whole corpus (new + changed + unchanged of run 1).
    expect(rerun.chunks.new).toBe(0);
    expect(rerun.chunks.changed).toBe(0);
    expect(rerun.chunks.removed).toBe(0);
    expect(rerun.chunks.unchanged).toBe(
      report.chunks.new + report.chunks.changed + report.chunks.unchanged,
    );
    expect(rerun.chunks.unchanged).toBeGreaterThan(0);

    const after = await pool.query<{ corpus_digest: string }>(
      "select corpus_digest from ingest_runs order by created_at desc limit 1",
    );
    expect(after.rows[0]?.corpus_digest).toBe(report.corpusDigest);
    if (before.rows[0]?.corpus_digest) {
      expect(after.rows[0]?.corpus_digest).toBe(before.rows[0].corpus_digest);
    }
  });

  it("appends an ingest.triggered audit event (append-only trail)", async () => {
    const res = await pool.query<{ count: string }>(
      "select count(*)::text from audit_events where event_type = 'ingest.triggered'",
    );
    expect(Number(res.rows[0]?.count)).toBeGreaterThan(0);
  });
});

describe("409 INGEST_IN_PROGRESS (api-contracts §1/§2)", () => {
  it("surfaces the ai-service advisory-lock conflict as 409 INGEST_IN_PROGRESS", async () => {
    // Deterministic: hold the ai-service's ingest advisory lock (session-scoped)
    // on our own connection — mro_ai/ingest.py's pg_try_advisory_lock then fails.
    const holder = new pg.Client({
      connectionString:
        process.env.MRO_DATABASE_URL ??
        "postgresql://turnaround:turnaround@localhost:5433/mro_copilot",
    });
    await holder.connect();
    try {
      await holder.query("select pg_advisory_lock($1)", [INGEST_LOCK_KEY]);
      const { status, body } = await postIngest(reviewerCookie);
      expect(status).toBe(409);
      const error = body.error as { code?: string; message?: string };
      expect(error?.code).toBe("INGEST_IN_PROGRESS");
      expect(typeof error?.message).toBe("string");
    } finally {
      await holder.query("select pg_advisory_unlock($1)", [INGEST_LOCK_KEY]).catch(() => {});
      await holder.end();
    }
  });
});
