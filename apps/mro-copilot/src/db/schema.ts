import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * mro-copilot schema — F1 slice of data-model.md (§1 ERD, §2 table notes).
 * Later tables (answers, audit_events, engine health, eval_runs) arrive with
 * their own milestones as additive forward-only migrations. Conventions:
 * - `chunks.embedding` is `vector(384)` with an HNSW cosine index (ADR-0010).
 * - `chunks.tsv` is a generated tsvector column with a GIN index — the lexical
 *   leg of hybrid retrieval (architecture.md §4).
 * - `chunks.chunk_hash` is the re-ingest idempotency key (FR-5).
 * - pgvector must exist before this migration runs: the migration file starts
 *   with `CREATE EXTENSION IF NOT EXISTS vector` (loud failure if absent,
 *   architecture.md §6).
 */

/** tsvector is not (yet) a first-class drizzle type — driver passes through text. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

export const userRoleEnum = pgEnum("user_role", ["viewer", "engineer", "reviewer"]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  /** Role ladder per PRD F-7: viewer < engineer < reviewer (D-09 pattern). */
  role: userRoleEnum("role").notNull().default("viewer"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

export const docTypeEnum = pgEnum("doc_type", ["AMM", "IPC", "TSM", "SB"]);
export const manualStatusEnum = pgEnum("manual_status", ["active", "superseded"]);

export const manuals = pgTable(
  "manuals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    docType: docTypeEnum("doc_type").notNull(),
    title: text("title").notNull(),
    /** ATA chapter, e.g. "29" (hydraulic power) — corpus is fictional NX-320. */
    ataChapter: text("ata_chapter").notNull(),
    /** AMM/TSM task number style "29-11-00-000-401"; null for IPC figures/SB sections. */
    taskNo: text("task_no"),
    revision: text("revision").notNull(),
    effectiveDate: date("effective_date").notNull(),
    status: manualStatusEnum("status").notNull().default("active"),
    sourcePath: text("source_path").notNull(),
  },
  (table) => [
    // Supersession key (data-model.md §2): a new revision inserts a new row and
    // flips the old one to `superseded` — history is never deleted (FR-6).
    uniqueIndex("manuals_doc_type_task_no_revision_key").on(
      table.docType,
      table.taskNo,
      table.revision,
    ),
    index("manuals_doc_type_idx").on(table.docType),
    index("manuals_ata_chapter_idx").on(table.ataChapter),
  ],
);

export type ManualRow = typeof manuals.$inferSelect;
export type NewManualRow = typeof manuals.$inferInsert;

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    manualId: uuid("manual_id")
      .notNull()
      .references(() => manuals.id, { onDelete: "cascade" }),
    /** sha256(manual + section + idx + content) — idempotency key (FR-5, §5). */
    chunkHash: text("chunk_hash").notNull(),
    sectionPath: text("section_path").notNull(),
    /** Fictional page marker rendered by every citation (FR-6). */
    page: integer("page").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    tokenCount: integer("token_count").notNull(),
    embedding: vector("embedding", { dimensions: 384 }),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('english', "content")`),
  },
  (table) => [
    uniqueIndex("chunks_chunk_hash_key").on(table.chunkHash),
    // Hybrid retrieval indexes (ADR-0010): HNSW cosine for the semantic leg,
    // GIN for the lexical leg. Names are asserted by the F1 migration test.
    index("chunks_embedding_hnsw_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
    index("chunks_tsv_gin_idx").using("gin", table.tsv),
    index("chunks_manual_id_idx").on(table.manualId),
  ],
);

export type ChunkRow = typeof chunks.$inferSelect;
export type NewChunkRow = typeof chunks.$inferInsert;

/**
 * Ingest evidence (data-model.md §2): one row per ingest run — corpus digest,
 * chunk counts (new/changed/unchanged/removed), embedding model, duration and
 * the full report JSONB. This is the evidence backing the FR-5 idempotency DoD.
 * Added with F2 (additive forward-only migration, engineering-standards §8).
 */
export const ingestRuns = pgTable("ingest_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** sha256 over the sorted chunk-hash set — the corpus fingerprint. */
  corpusDigest: text("corpus_digest").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  manualsTouched: integer("manuals_touched").notNull(),
  chunksNew: integer("chunks_new").notNull(),
  chunksChanged: integer("chunks_changed").notNull(),
  chunksUnchanged: integer("chunks_unchanged").notNull(),
  chunksRemoved: integer("chunks_removed").notNull().default(0),
  durationMs: integer("duration_ms").notNull(),
  /** completed | failed */
  status: text("status").notNull(),
  report: jsonb("report").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type IngestRunRow = typeof ingestRuns.$inferSelect;
export type NewIngestRow = typeof ingestRuns.$inferInsert;

// --- F3: RAG answers, citations, audit, eval runs, idempotency ---------------
// (data-model.md §1/§2 — additive forward-only migration 0002.)

export const answerStatusEnum = pgEnum("answer_status", [
  "draft",
  "refused",
  "approved",
  "rejected",
]);

/**
 * `none` (additive, migration 0003) labels refusals honestly: no generation
 * source contributed content to a refused answer (FR-10/FR-12).
 */
export const answerSourceEnum = pgEnum("answer_source", ["llm", "extractive", "none"]);

/**
 * RAG answers (data-model.md §1 ANSWER, PRD FR-9..FR-14). `refused` is
 * terminal; lifecycle `draft → approved | rejected` transitions are recorded
 * as append-only audit events. `answer_text` is null exactly when refused.
 */
export const answers = pgTable(
  "answers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    question: text("question").notNull(),
    answerText: text("answer_text"),
    status: answerStatusEnum("status").notNull().default("draft"),
    /** below_grounding_threshold | no_valid_citations (FR-10). */
    refusalReason: text("refusal_reason"),
    source: answerSourceEnum("source").notNull(),
    /** mock | none (extractive fallback has no provider — FR-12 honesty). */
    provider: text("provider").notNull(),
    groundingScore: doublePrecision("grounding_score").notNull(),
    /** {mode: hybrid|lexical, topK, latencyMs} (data-model.md §1). */
    retrievalMeta: jsonb("retrieval_meta").notNull(),
    tokenUsage: jsonb("token_usage"),
    latencyMs: integer("latency_ms").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    /** {reviewerId, note, at} — written once on approve/reject (FR-14). */
    review: jsonb("review"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("answers_created_at_idx").on(table.createdAt),
    index("answers_status_idx").on(table.status),
    index("answers_created_by_idx").on(table.createdBy),
  ],
);

export type AnswerRow = typeof answers.$inferSelect;
export type NewAnswerRow = typeof answers.$inferInsert;

/**
 * Citation rows (api-contracts.md §1 Citation): every citation references a
 * chunk that was actually retrieved for this answer — the FR-11 validity
 * invariant is enforced in code before insert. Display fields are denormalized
 * so citations stay resolvable even if the manual is later superseded (FR-6:
 * history is never rewritten).
 */
export const answerCitations = pgTable(
  "answer_citations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    answerId: uuid("answer_id")
      .notNull()
      .references(() => answers.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    chunkId: uuid("chunk_id")
      .notNull()
      .references(() => chunks.id),
    manualId: uuid("manual_id")
      .notNull()
      .references(() => manuals.id),
    docType: docTypeEnum("doc_type").notNull(),
    ataChapter: text("ata_chapter").notNull(),
    taskNo: text("task_no").notNull(),
    sectionPath: text("section_path").notNull(),
    page: integer("page").notNull(),
    revision: text("revision").notNull(),
    snippet: text("snippet").notNull(),
  },
  (table) => [uniqueIndex("answer_citations_answer_seq_key").on(table.answerId, table.seq)],
);

export type AnswerCitationRow = typeof answerCitations.$inferSelect;
export type NewAnswerCitationRow = typeof answerCitations.$inferInsert;

/**
 * Append-only audit (data-model.md §2): lifecycle events are INSERT-only.
 * UPDATE/DELETE are blocked by a database trigger (migration 0002), mirroring
 * turnaround-iq's event_log discipline. Types: answer.created, answer.approved,
 * answer.rejected (+ ingest.completed, alert.* in later milestones).
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Strict monotonic order for replay — inserts only. */
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    answerId: uuid("answer_id").references(() => answers.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_answer_idx").on(table.answerId),
    index("audit_events_type_idx").on(table.eventType),
  ],
);

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;

/**
 * Eval run evidence (data-model.md §2, PRD FR-21): one row per committed eval
 * run — written only by the eval CLI via POST /api/v1/evals, read back by the
 * reviewer eval dashboard (GET /api/v1/evals).
 */
export const evalRuns = pgTable("eval_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** retrieval | full — which harness produced the run. */
  mode: text("mode").notNull(),
  fixtureVersion: integer("fixture_version").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  metrics: jsonb("metrics").notNull(),
  gates: jsonb("gates").notNull(),
  passed: boolean("passed").notNull(),
  caseSummaries: jsonb("case_summaries").notNull(),
  reportPath: text("report_path"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EvalRunRow = typeof evalRuns.$inferSelect;
export type NewEvalRunRow = typeof evalRuns.$inferInsert;

/**
 * Idempotency-Key replay store (PRD FR-2, engineering-standards.md §4) for the
 * mutating F3 endpoints. mro-copilot has no Redis (architecture.md §1) — the
 * replay state is a plain PG table keyed by the client key.
 */
export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  status: integer("status").notNull(),
  responseBody: text("response_body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
