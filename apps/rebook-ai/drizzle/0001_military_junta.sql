CREATE TYPE "public"."flight_status" AS ENUM('scheduled', 'delayed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."notification_state" AS ENUM('queued', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."offer_state" AS ENUM('proposed', 'confirmed', 'expired', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."option_kind" AS ENUM('fast', 'cheap', 'flexible');--> statement-breakpoint
CREATE TYPE "public"."pnr_tier" AS ENUM('standard', 'silver', 'gold');--> statement-breakpoint
CREATE TYPE "public"."proposal_source" AS ENUM('llm', 'rules');--> statement-breakpoint
CREATE TYPE "public"."proposal_state" AS ENUM('proposed', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."rebook_role" AS ENUM('passenger', 'agent', 'supervisor');--> statement-breakpoint
CREATE TYPE "public"."saga_state" AS ENUM('running', 'completed', 'failed', 'compensated');--> statement-breakpoint
CREATE TYPE "public"."saga_step" AS ENUM('seat_reserve', 'payment', 'ticket_issue');--> statement-breakpoint
CREATE TYPE "public"."saga_step_state" AS ENUM('pending', 'running', 'done', 'failed', 'compensated');--> statement-breakpoint
CREATE TYPE "public"."segment_status" AS ENUM('confirmed', 'delayed', 'cancelled', 'rebooked');--> statement-breakpoint
CREATE TYPE "public"."voucher_state" AS ENUM('issued', 'used');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_role" "rebook_role" NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"offer_option_id" uuid NOT NULL,
	"pnr_id" uuid NOT NULL,
	"by_user_id" uuid NOT NULL,
	"by_role" "rebook_role" NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "confirmations_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"process_error" text,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "flights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"airline" text NOT NULL,
	"flight_no" text NOT NULL,
	"origin" text NOT NULL,
	"dest" text NOT NULL,
	"sched_dep" timestamp with time zone NOT NULL,
	"sched_arr" timestamp with time zone NOT NULL,
	"aircraft" text NOT NULL,
	"status" "flight_status" DEFAULT 'scheduled' NOT NULL,
	"delay_minutes" integer DEFAULT 0 NOT NULL
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
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pnr_id" uuid NOT NULL,
	"channel" text DEFAULT 'inbox' NOT NULL,
	"state" "notification_state" DEFAULT 'queued' NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "offer_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"kind" "option_kind" NOT NULL,
	"reason" text NOT NULL,
	"itinerary" jsonb NOT NULL,
	"fare_delta" integer NOT NULL,
	"interline" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pnr_id" uuid NOT NULL,
	"state" "offer_state" DEFAULT 'proposed' NOT NULL,
	"context" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pnr" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"locator" text NOT NULL,
	"user_id" uuid,
	"passenger_name" text NOT NULL,
	"tier" "pnr_tier" DEFAULT 'standard' NOT NULL,
	"fare_class" text NOT NULL,
	"contact_handle" text NOT NULL,
	"party_size" integer DEFAULT 1 NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pnr_locator_unique" UNIQUE("locator")
);
--> statement-breakpoint
CREATE TABLE "pnr_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pnr_id" uuid NOT NULL,
	"airline" text NOT NULL,
	"flight_no" text NOT NULL,
	"flight_date" timestamp with time zone NOT NULL,
	"origin" text NOT NULL,
	"dest" text NOT NULL,
	"cabin" text NOT NULL,
	"status" "segment_status" DEFAULT 'confirmed' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pnr_id" uuid NOT NULL,
	"recommended_option_id" uuid,
	"source" "proposal_source" NOT NULL,
	"provider" text NOT NULL,
	"trace" jsonb,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"state" "proposal_state" DEFAULT 'proposed' NOT NULL,
	"approver_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saga_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"saga_id" uuid NOT NULL,
	"step" "saga_step" NOT NULL,
	"state" "saga_step_state" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"request" jsonb,
	"response" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saga_steps_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "sagas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pnr_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"state" "saga_state" DEFAULT 'running' NOT NULL,
	"current_step" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pnr_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"currency" text DEFAULT 'SGD' NOT NULL,
	"state" "voucher_state" DEFAULT 'issued' NOT NULL,
	"criteria" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmations" ADD CONSTRAINT "confirmations_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmations" ADD CONSTRAINT "confirmations_offer_option_id_offer_options_id_fk" FOREIGN KEY ("offer_option_id") REFERENCES "public"."offer_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmations" ADD CONSTRAINT "confirmations_pnr_id_pnr_id_fk" FOREIGN KEY ("pnr_id") REFERENCES "public"."pnr"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmations" ADD CONSTRAINT "confirmations_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_pnr_id_pnr_id_fk" FOREIGN KEY ("pnr_id") REFERENCES "public"."pnr"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_options" ADD CONSTRAINT "offer_options_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_pnr_id_pnr_id_fk" FOREIGN KEY ("pnr_id") REFERENCES "public"."pnr"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pnr" ADD CONSTRAINT "pnr_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pnr_segments" ADD CONSTRAINT "pnr_segments_pnr_id_pnr_id_fk" FOREIGN KEY ("pnr_id") REFERENCES "public"."pnr"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_pnr_id_pnr_id_fk" FOREIGN KEY ("pnr_id") REFERENCES "public"."pnr"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_recommended_option_id_offer_options_id_fk" FOREIGN KEY ("recommended_option_id") REFERENCES "public"."offer_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saga_steps" ADD CONSTRAINT "saga_steps_saga_id_sagas_id_fk" FOREIGN KEY ("saga_id") REFERENCES "public"."sagas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sagas" ADD CONSTRAINT "sagas_pnr_id_pnr_id_fk" FOREIGN KEY ("pnr_id") REFERENCES "public"."pnr"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sagas" ADD CONSTRAINT "sagas_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_pnr_id_pnr_id_fk" FOREIGN KEY ("pnr_id") REFERENCES "public"."pnr"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "confirmations_pnr_idx" ON "confirmations" USING btree ("pnr_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_log_aggregate_sequence_unique" ON "event_log" USING btree ("aggregate_id","sequence");--> statement-breakpoint
CREATE INDEX "event_log_processed_idx" ON "event_log" USING btree ("processed","id");--> statement-breakpoint
CREATE UNIQUE INDEX "flights_flight_no_unique" ON "flights" USING btree ("flight_no");--> statement-breakpoint
CREATE INDEX "flights_status_idx" ON "flights" USING btree ("status");--> statement-breakpoint
CREATE INDEX "notifications_pnr_idx" ON "notifications" USING btree ("pnr_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_options_offer_rank_unique" ON "offer_options" USING btree ("offer_id","rank");--> statement-breakpoint
CREATE INDEX "offers_pnr_state_idx" ON "offers" USING btree ("pnr_id","state");--> statement-breakpoint
CREATE INDEX "offers_expires_idx" ON "offers" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "offers_context_gin" ON "offers" USING gin ("context");--> statement-breakpoint
CREATE INDEX "pnr_user_idx" ON "pnr" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pnr_document_gin" ON "pnr" USING gin ("document");--> statement-breakpoint
CREATE INDEX "pnr_segments_pnr_idx" ON "pnr_segments" USING btree ("pnr_id");--> statement-breakpoint
CREATE INDEX "pnr_segments_flight_idx" ON "pnr_segments" USING btree ("flight_no");--> statement-breakpoint
CREATE INDEX "proposals_pnr_idx" ON "proposals" USING btree ("pnr_id");--> statement-breakpoint
CREATE INDEX "proposals_state_idx" ON "proposals" USING btree ("state");--> statement-breakpoint
CREATE INDEX "saga_steps_saga_state_idx" ON "saga_steps" USING btree ("saga_id","state");--> statement-breakpoint
CREATE INDEX "sagas_pnr_idx" ON "sagas" USING btree ("pnr_id");--> statement-breakpoint
CREATE INDEX "sagas_state_idx" ON "sagas" USING btree ("state");--> statement-breakpoint
CREATE INDEX "vouchers_pnr_idx" ON "vouchers" USING btree ("pnr_id");--> statement-breakpoint
CREATE INDEX "vouchers_criteria_gin" ON "vouchers" USING gin ("criteria");-- statement-breakpoint
-- Append-only enforcement (data-model.md §2): audit events are INSERT-only.
-- A database trigger blocks UPDATE/DELETE for every role — the app cannot
-- rewrite the decision trail even by bug (mro-copilot precedent).
CREATE OR REPLACE FUNCTION rb_audit_events_append_only() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'audit_events is append-only: % is not permitted (data-model.md §2)', TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
	BEFORE UPDATE OR DELETE ON "audit_events"
	FOR EACH ROW EXECUTE FUNCTION rb_audit_events_append_only();
