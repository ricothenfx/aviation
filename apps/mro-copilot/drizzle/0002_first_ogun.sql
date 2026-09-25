CREATE TYPE "public"."answer_source" AS ENUM('llm', 'extractive');--> statement-breakpoint
CREATE TYPE "public"."answer_status" AS ENUM('draft', 'refused', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "answer_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"answer_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"chunk_id" uuid NOT NULL,
	"manual_id" uuid NOT NULL,
	"doc_type" "doc_type" NOT NULL,
	"ata_chapter" text NOT NULL,
	"task_no" text NOT NULL,
	"section_path" text NOT NULL,
	"page" integer NOT NULL,
	"revision" text NOT NULL,
	"snippet" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question" text NOT NULL,
	"answer_text" text,
	"status" "answer_status" DEFAULT 'draft' NOT NULL,
	"refusal_reason" text,
	"source" "answer_source" NOT NULL,
	"provider" text NOT NULL,
	"grounding_score" double precision NOT NULL,
	"retrieval_meta" jsonb NOT NULL,
	"token_usage" jsonb,
	"latency_ms" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"review" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"event_type" text NOT NULL,
	"answer_id" uuid,
	"actor_id" uuid,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mode" text NOT NULL,
	"fixture_version" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"metrics" jsonb NOT NULL,
	"gates" jsonb NOT NULL,
	"passed" boolean NOT NULL,
	"case_summaries" jsonb NOT NULL,
	"report_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status" integer NOT NULL,
	"response_body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answer_citations" ADD CONSTRAINT "answer_citations_answer_id_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_citations" ADD CONSTRAINT "answer_citations_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_citations" ADD CONSTRAINT "answer_citations_manual_id_manuals_id_fk" FOREIGN KEY ("manual_id") REFERENCES "public"."manuals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_answer_id_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answer_citations_answer_seq_key" ON "answer_citations" USING btree ("answer_id","seq");--> statement-breakpoint
CREATE INDEX "answers_created_at_idx" ON "answers" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "answers_status_idx" ON "answers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "answers_created_by_idx" ON "answers" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "audit_events_answer_idx" ON "audit_events" USING btree ("answer_id");--> statement-breakpoint
CREATE INDEX "audit_events_type_idx" ON "audit_events" USING btree ("event_type");--> statement-breakpoint
-- Append-only enforcement (data-model.md §2): audit events are INSERT-only.
-- A database trigger blocks UPDATE/DELETE for every role — the app cannot
-- rewrite history even by bug (mirrors turnaround-iq's event_log discipline).
CREATE OR REPLACE FUNCTION mro_audit_events_append_only() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'audit_events is append-only: % is not permitted (data-model.md §2)', TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
	BEFORE UPDATE OR DELETE ON "audit_events"
	FOR EACH ROW EXECUTE FUNCTION mro_audit_events_append_only();