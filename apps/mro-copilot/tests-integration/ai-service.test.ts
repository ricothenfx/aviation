import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

/**
 * ai-service contract DoD (F1): /internal/v1/embed is deterministic over the
 * wire (same text ⇒ same 384-dim vector) with the shared bearer token, and
 * /readyz reports DB, pgvector, model artifact and provider dependencies
 * (architecture.md §7). Runs against the compose stack.
 */

const AI_BASE_URL = process.env.MRO_AI_SERVICE_URL ?? "http://localhost:4103";
// Compose dev bearer (CI passes the same value via env — mro.yml).
const TOKEN = process.env.AI_SERVICE_TOKEN ?? "dev-only-insecure-ai-token-0123456789abcdef";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

const pool = new Pool({
  connectionString:
    process.env.MRO_DATABASE_URL ?? "postgresql://turnaround:turnaround@localhost:5433/mro_copilot",
  max: 2,
});

afterAll(async () => {
  await pool.end();
});

describe("ai-service readiness", () => {
  it("reports db, pgvector, model and provider", async () => {
    const res = await fetch(`${AI_BASE_URL}/readyz`, { headers: AUTH });
    // F4: the committed artifact loads and hash-verifies — readiness includes
    // the RUL model dependency (architecture.md §6).
    expect([200, 503]).toContain(res.status);
    const body = (await res.json()) as {
      status: string;
      dependencies: Record<string, string>;
    };
    expect(Object.keys(body.dependencies).sort()).toEqual([
      "model",
      "pgvector",
      "postgres",
      "provider",
    ]);
    if (res.status === 200) {
      expect(body.dependencies.postgres).toBe("up");
      expect(body.dependencies.pgvector).toBe("up");
      expect(body.dependencies.provider).toBe("up");
      expect(body.dependencies.model).toBe("up");
      expect(body.status).toBe("ready");
    } else {
      expect(body.dependencies.model).toBe("not_loaded");
    }
  });

  it("exposes prometheus metrics", async () => {
    const res = await fetch(`${AI_BASE_URL}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("embed_latency_seconds");
    expect(text).toContain("embed_requests_total");
  });
});

describe("/internal/v1/embed determinism (DoD F1)", () => {
  it("rejects requests without the bearer token", async () => {
    const res = await fetch(`${AI_BASE_URL}/internal/v1/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: ["hydraulic reservoir check"] }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it("returns the same 384-dim vector for the same text", async () => {
    const payload = { texts: ["Hydraulic reservoir pressurization check before APU start."] };
    const first = await fetch(`${AI_BASE_URL}/internal/v1/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${AI_BASE_URL}/internal/v1/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify(payload),
    });
    const a = (await first.json()) as { model: string; vectors: number[][]; usage: unknown };
    const b = (await second.json()) as typeof a;
    expect(a).toEqual(b);
    expect(a.model).toBe("mock-hashed-ngram-384");
    expect(a.vectors).toHaveLength(1);
    expect(a.vectors[0]).toHaveLength(384);
    expect(a.usage).toMatchObject({ inputTokens: expect.any(Number) });
  });

  it("distinguishes different texts", async () => {
    const embed = (text: string) =>
      fetch(`${AI_BASE_URL}/internal/v1/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH },
        body: JSON.stringify({ texts: [text] }),
      }).then((r) => r.json() as Promise<{ vectors: number[][] }>);
    const a = await embed("no airflow after start");
    const b = await embed("torque value for the main landing gear");
    expect(a.vectors[0]).not.toEqual(b.vectors[0]);
  });

  it("serves an ingested corpus since F2 (chunks stored with embeddings)", async () => {
    // F2 (PRD FR-5) populated the corpus; the detailed integrity and
    // idempotency invariants live in the F2 integration suites.
    const res = await pool.query<{ total: string; embedded: string }>(
      "select count(*)::text as total, count(embedding)::text as embedded from chunks",
    );
    expect(Number(res.rows[0]?.total)).toBeGreaterThanOrEqual(600);
    expect(res.rows[0]?.embedded).toBe(res.rows[0]?.total);
  });
});
