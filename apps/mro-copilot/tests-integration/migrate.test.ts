import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

/**
 * Migration DoD (F1): after `db:migrate` the `mro_copilot` database must have
 * the `vector` extension, an HNSW cosine index on chunks.embedding and a GIN
 * index on chunks.tsv (data-model.md §2, ADR-0010). Runs against the compose
 * stack (DATABASE_URL points at mro_copilot).
 */

const pool = new Pool({
  connectionString:
    process.env.MRO_DATABASE_URL ?? "postgresql://turnaround:turnaround@localhost:5433/mro_copilot",
  max: 2,
});

afterAll(async () => {
  await pool.end();
});

describe("pgvector migration (ADR-0010)", () => {
  it("has the vector extension installed", async () => {
    const res = await pool.query<{ extname: string; extversion: string }>(
      "select extname, extversion from pg_extension where extname = 'vector'",
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0]?.extversion).toMatch(/^0\.(5|6|7|8|9)\./);
  });

  it("has an HNSW cosine index on chunks.embedding", async () => {
    const res = await pool.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where indexname = 'chunks_embedding_hnsw_idx'",
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0]?.indexdef).toContain("USING hnsw");
    expect(res.rows[0]?.indexdef).toContain("vector_cosine_ops");
  });

  it("has a GIN index on chunks.tsv (generated tsvector)", async () => {
    const res = await pool.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where indexname = 'chunks_tsv_gin_idx'",
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0]?.indexdef).toContain("USING gin");
  });

  it("exposes the generated tsvector column end-to-end", async () => {
    const res = await pool.query<{ ok: number }>(
      "select count(*)::int as ok from pg_attribute " +
        "where attrelid = 'chunks'::regclass and attname = 'tsv' and attgenerated <> '0'",
    );
    expect(res.rows[0]?.ok).toBe(1);
  });

  it("keeps the chunk-hash idempotency key unique (FR-5)", async () => {
    const res = await pool.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where indexname = 'chunks_chunk_hash_key'",
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0]?.indexdef).toContain("UNIQUE");
  });
});
