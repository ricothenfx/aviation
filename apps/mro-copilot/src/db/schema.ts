import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  date,
  index,
  integer,
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
