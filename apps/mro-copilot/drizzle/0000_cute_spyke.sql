-- pgvector (ADR-0010): the extension must exist before the `vector(384)`
-- column type is referenced below. Fails loudly on a cluster without the
-- extension (architecture.md §6 — documented remediation, never silent).
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."doc_type" AS ENUM('AMM', 'IPC', 'TSM', 'SB');--> statement-breakpoint
CREATE TYPE "public"."manual_status" AS ENUM('active', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('viewer', 'engineer', 'reviewer');--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manual_id" uuid NOT NULL,
	"chunk_hash" text NOT NULL,
	"section_path" text NOT NULL,
	"page" integer NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"token_count" integer NOT NULL,
	"embedding" vector(384),
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED
);
--> statement-breakpoint
CREATE TABLE "manuals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_type" "doc_type" NOT NULL,
	"title" text NOT NULL,
	"ata_chapter" text NOT NULL,
	"task_no" text,
	"revision" text NOT NULL,
	"effective_date" date NOT NULL,
	"status" "manual_status" DEFAULT 'active' NOT NULL,
	"source_path" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_manual_id_manuals_id_fk" FOREIGN KEY ("manual_id") REFERENCES "public"."manuals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_chunk_hash_key" ON "chunks" USING btree ("chunk_hash");--> statement-breakpoint
CREATE INDEX "chunks_embedding_hnsw_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "chunks_tsv_gin_idx" ON "chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "chunks_manual_id_idx" ON "chunks" USING btree ("manual_id");--> statement-breakpoint
CREATE UNIQUE INDEX "manuals_doc_type_task_no_revision_key" ON "manuals" USING btree ("doc_type","task_no","revision");--> statement-breakpoint
CREATE INDEX "manuals_doc_type_idx" ON "manuals" USING btree ("doc_type");--> statement-breakpoint
CREATE INDEX "manuals_ata_chapter_idx" ON "manuals" USING btree ("ata_chapter");