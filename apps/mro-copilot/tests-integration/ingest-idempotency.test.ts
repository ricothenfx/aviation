import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

/**
 * Ingest idempotency (DoD F2, PRD FR-5, api-contracts.md §4): re-running the
 * ingest job over an unchanged corpus yields an identical chunk-hash set and
 * vector count. Drives the internal ingest endpoint (same code path as the
 * CLI) and inspects the database through the shared compose postgres.
 */

const AI_URL = process.env.MRO_AI_SERVICE_URL ?? "http://localhost:4103";
const TOKEN = process.env.AI_SERVICE_TOKEN ?? "dev-only-insecure-ai-token-0123456789abcdef";

const pool = new Pool({
  connectionString:
    process.env.MRO_DATABASE_URL ?? "postgresql://turnaround:turnaround@localhost:5433/mro_copilot",
  max: 2,
});

beforeAll(async () => {
  // The corpus must be ingested before the idempotency comparison (the compose
  // ai-service ingests at startup; this guards against a still-booting stack).
  await expect_ingested();
});

afterAll(async () => {
  await pool.end();
});

async function expect_ingested(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await pool.query<{ count: string }>("select count(*)::text from chunks");
    if (Number(res.rows[0]?.count) > 0) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("corpus was never ingested — ai-service ingest did not run");
}

async function triggerIngest(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${AI_URL}/internal/v1/ingest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function snapshot(): Promise<{ hashes: string[]; embedded: number; digest: string | null }> {
  const hashes = await pool.query<{ chunk_hash: string }>(
    "select chunk_hash from chunks order by chunk_hash",
  );
  const embedded = await pool.query<{ count: string }>(
    "select count(*)::text from chunks where embedding is not null",
  );
  const digest = await pool.query<{ corpus_digest: string }>(
    "select corpus_digest from ingest_runs order by created_at desc limit 1",
  );
  return {
    hashes: hashes.rows.map((r) => r.chunk_hash),
    embedded: Number(embedded.rows[0]?.count),
    digest: digest.rows[0]?.corpus_digest ?? null,
  };
}

describe("ingest idempotency (FR-5)", () => {
  it("re-ingesting the unchanged corpus changes no chunk hash and no vector count", async () => {
    const before = await snapshot();

    const { status, body } = await triggerIngest();
    expect(status).toBe(200);
    const chunks = body.chunks as { new: number; changed: number; unchanged: number };
    expect(chunks.new).toBe(0);
    expect(chunks.changed).toBe(0);
    expect(chunks.unchanged).toBeGreaterThan(0);

    const after = await snapshot();
    expect(after.hashes).toEqual(before.hashes);
    expect(after.hashes.length).toBeGreaterThan(0);
    expect(after.embedded).toBe(before.embedded);
    expect(after.digest).toBe(before.digest);
  });

  it("records an ingest_runs evidence row with the camelCase report", async () => {
    const res = await pool.query<{ report: Record<string, unknown> }>(
      "select report from ingest_runs order by created_at desc limit 1",
    );
    const report = res.rows[0]?.report as {
      corpusDigest?: string;
      chunks?: { new: number; changed: number; unchanged: number; removed: number };
      embeddingModel?: string;
      durationMs?: number;
    };
    expect(report.corpusDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.embeddingModel).toBe("mock-hashed-ngram-384");
    expect(report.chunks?.new).toBe(0);
    expect(typeof report.durationMs).toBe("number");
  });
});
