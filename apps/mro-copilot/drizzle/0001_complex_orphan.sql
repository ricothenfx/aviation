CREATE TABLE "ingest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corpus_digest" text NOT NULL,
	"embedding_model" text NOT NULL,
	"manuals_touched" integer NOT NULL,
	"chunks_new" integer NOT NULL,
	"chunks_changed" integer NOT NULL,
	"chunks_unchanged" integer NOT NULL,
	"chunks_removed" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer NOT NULL,
	"status" text NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
