CREATE TYPE "public"."alert_state" AS ENUM('raised', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."engine_status" AS ENUM('active', 'removed');--> statement-breakpoint
CREATE TABLE "engine_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" text NOT NULL,
	"state" "alert_state" DEFAULT 'raised' NOT NULL,
	"projected_rul" integer NOT NULL,
	"threshold" integer NOT NULL,
	"lead_cycles" integer NOT NULL,
	"model_version" text NOT NULL,
	"model_sha256" text NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolve_note" text
);
--> statement-breakpoint
CREATE TABLE "engine_units" (
	"unit_id" text PRIMARY KEY NOT NULL,
	"dataset" text NOT NULL,
	"window_threshold_cycles" integer NOT NULL,
	"status" "engine_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rul_predictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" text NOT NULL,
	"cycle" integer NOT NULL,
	"rul_cycles" integer NOT NULL,
	"band_low" integer NOT NULL,
	"band_high" integer NOT NULL,
	"model_version" text NOT NULL,
	"model_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sensor_readings" (
	"unit_id" text NOT NULL,
	"cycle" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"setting1" double precision NOT NULL,
	"setting2" double precision NOT NULL,
	"setting3" double precision NOT NULL,
	"s1" double precision NOT NULL,
	"s2" double precision NOT NULL,
	"s3" double precision NOT NULL,
	"s4" double precision NOT NULL,
	"s5" double precision NOT NULL,
	"s6" double precision NOT NULL,
	"s7" double precision NOT NULL,
	"s8" double precision NOT NULL,
	"s9" double precision NOT NULL,
	"s10" double precision NOT NULL,
	"s11" double precision NOT NULL,
	"s12" double precision NOT NULL,
	"s13" double precision NOT NULL,
	"s14" double precision NOT NULL,
	"s15" double precision NOT NULL,
	"s16" double precision NOT NULL,
	"s17" double precision NOT NULL,
	"s18" double precision NOT NULL,
	"s19" double precision NOT NULL,
	"s20" double precision NOT NULL,
	"s21" double precision NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "alert_id" uuid;--> statement-breakpoint
ALTER TABLE "engine_alerts" ADD CONSTRAINT "engine_alerts_unit_id_engine_units_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."engine_units"("unit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engine_alerts" ADD CONSTRAINT "engine_alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engine_alerts" ADD CONSTRAINT "engine_alerts_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rul_predictions" ADD CONSTRAINT "rul_predictions_unit_id_engine_units_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."engine_units"("unit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensor_readings" ADD CONSTRAINT "sensor_readings_unit_id_engine_units_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."engine_units"("unit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "engine_alerts_unit_idx" ON "engine_alerts" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "engine_alerts_state_idx" ON "engine_alerts" USING btree ("state");--> statement-breakpoint
CREATE INDEX "engine_units_status_idx" ON "engine_units" USING btree ("status");--> statement-breakpoint
CREATE INDEX "rul_predictions_unit_cycle_idx" ON "rul_predictions" USING btree ("unit_id","cycle");--> statement-breakpoint
CREATE INDEX "rul_predictions_unit_created_idx" ON "rul_predictions" USING btree ("unit_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sensor_readings_unit_cycle_recorded_key" ON "sensor_readings" USING btree ("unit_id","cycle","recorded_at");--> statement-breakpoint
CREATE INDEX "sensor_readings_unit_cycle_idx" ON "sensor_readings" USING btree ("unit_id","cycle");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_alert_id_engine_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."engine_alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_alert_idx" ON "audit_events" USING btree ("alert_id");--> statement-breakpoint
-- TimescaleDB hypertable (data-model.md §8): sensor_readings is time-series
-- storage with a real time axis. recorded_at is a DETERMINISTIC synthetic
-- timestamp (EPOCH 2000-01-01T00:00:00Z + cycle × 1 day), enforced below by a
-- CHECK so the mapping can never drift from the cycle column. The image ships
-- the timescaledb extension (recorded in ADR-0010 for pgvector coexistence).
CREATE EXTENSION IF NOT EXISTS timescaledb;--> statement-breakpoint
SELECT create_hypertable(
	'sensor_readings',
	'recorded_at',
	chunk_time_interval => INTERVAL '30 days',
	if_not_exists => TRUE,
	migrate_data => TRUE
);--> statement-breakpoint
ALTER TABLE "sensor_readings" ADD CONSTRAINT "sensor_readings_recorded_at_deterministic"
	CHECK ("recorded_at" = '2000-01-01 00:00:00+00'::timestamptz + "cycle" * INTERVAL '1 day');--> statement-breakpoint
-- Compression after 90 synthetic days (data-model.md §6): chunks older than
-- 90 days compress automatically; synthetic history ages quickly (1 cycle =
-- 1 day), which is the point.
ALTER TABLE "sensor_readings" SET (
	timescaledb.compress,
	timescaledb.compress_segmentby = 'unit_id'
);--> statement-breakpoint
SELECT add_compression_policy('sensor_readings', INTERVAL '90 days', if_not_exists => TRUE);
