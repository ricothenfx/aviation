import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

/**
 * Corpus integrity spot-check (DoD F2): >= 40 docs, >= 600 chunks, and every
 * chunk resolvable to doc + section + fictional page + revision (PRD FR-4/
 * FR-6, data-model.md §4). Also asserts the chunking contract: content starts
 * with the canonical breadcrumb, tokens within the §5 band, warnings attached
 * to their parent steps.
 */

const pool = new Pool({
  connectionString:
    process.env.MRO_DATABASE_URL ?? "postgresql://turnaround:turnaround@localhost:5433/mro_copilot",
  max: 2,
});

afterAll(async () => {
  await pool.end();
});

describe("committed corpus is ingested and resolvable (DoD F2)", () => {
  it("has at least 40 manuals across all four doc types", async () => {
    const res = await pool.query<{ doc_type: string; count: string }>(
      "select doc_type::text, count(*)::text from manuals group by doc_type::text",
    );
    const byType = Object.fromEntries(res.rows.map((r) => [r.doc_type, Number(r.count)]));
    for (const docType of ["AMM", "IPC", "TSM", "SB"]) {
      expect(byType[docType], `doc type ${docType} present`).toBeGreaterThan(0);
    }
    const total = res.rows.reduce((sum, r) => sum + Number(r.count), 0);
    expect(total).toBeGreaterThanOrEqual(40);
  });

  it("has at least 600 chunks within the sizing band", async () => {
    const res = await pool.query<{ count: string; max_tokens: string }>(
      "select count(*)::text as count, max(token_count)::text as max_tokens from chunks",
    );
    expect(Number(res.rows[0]?.count)).toBeGreaterThanOrEqual(600);
    expect(Number(res.rows[0]?.max_tokens)).toBeLessThanOrEqual(500); // hard cap (§5)
  });

  it("resolves every chunk to doc + section + page + revision (FR-6)", async () => {
    const missing = await pool.query<{ count: string }>(
      `select count(*)::text as count from chunks c
       join manuals m on m.id = c.manual_id
       where c.section_path = ''
          or c.page is null or c.page < 1
          or m.revision = '' or m.ata_chapter = ''
          or c.content is null or length(c.content) = 0`,
    );
    expect(Number(missing.rows[0]?.count)).toBe(0);
  });

  it("starts every chunk content with its canonical breadcrumb (§5)", async () => {
    const bad = await pool.query<{ count: string }>(
      "select count(*)::text as count from chunks where position(section_path in content) <> 1",
    );
    expect(Number(bad.rows[0]?.count)).toBe(0);
  });

  it("keeps warnings glued to their parent step blocks (§5)", async () => {
    // Sample content chunks containing a WARNING/CAUTION line and assert the
    // parent step (a numbered step) is in the same chunk content.
    const res = await pool.query<{ content: string }>(
      `select content from chunks where content like '%WARNING:%' or content like '%CAUTION:%' limit 25`,
    );
    expect(res.rows.length).toBeGreaterThan(0);
    for (const row of res.rows) {
      const hasStepBeforeWarning = /\d+\.\s+[\s\S]*?(WARNING|CAUTION):/.test(row.content);
      expect(hasStepBeforeWarning, "warning shares a chunk with a numbered step").toBe(true);
    }
  });

  it("marks the superseded SB revision while keeping both resolvable (FR-6)", async () => {
    const res = await pool.query<{ revision: string; status: string }>(
      "select revision, status::text from manuals where task_no = 'SB-29-002' order by revision",
    );
    expect(res.rows.length).toBe(2);
    expect(res.rows.map((r) => r.status)).toEqual(["superseded", "active"]);
  });

  it("embeds every chunk with the 384-dim mock model (idempotency basis)", async () => {
    const res = await pool.query<{ total: string; embedded: string }>(
      "select count(*)::text as total, count(embedding)::text as embedded from chunks",
    );
    expect(res.rows[0]?.embedded).toBe(res.rows[0]?.total);
  });
});
