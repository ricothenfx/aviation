CREATE TYPE "public"."aggregate_type" AS ENUM('flight', 'task', 'alert', 'replan', 'scenario');--> statement-breakpoint
CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."alert_state" AS ENUM('raised', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."event_producer" AS ENUM('simulator', 'replan_engine', 'user_action');--> statement-breakpoint
CREATE TYPE "public"."flight_status" AS ENUM('scheduled', 'in_block', 'turnaround', 'off_block', 'delayed');--> statement-breakpoint
CREATE TYPE "public"."replan_status" AS ENUM('proposed', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."stand_type" AS ENUM('narrow', 'wide');--> statement-breakpoint
CREATE TYPE "public"."task_state" AS ENUM('pending', 'in_progress', 'done', 'blocked');--> statement-breakpoint
CREATE TABLE "aircraft_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"turn_sla_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "aircraft_types_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"flight_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"state" "alert_state" DEFAULT 'raised' NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applied_events" (
	"consumer_id" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"last_sequence" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_type" "aggregate_type" NOT NULL,
	"type" text NOT NULL,
	"sequence" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"producer" "event_producer" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flights" (
	"id" uuid PRIMARY KEY NOT NULL,
	"flight_no" text NOT NULL,
	"stand_id" uuid NOT NULL,
	"aircraft_type_id" uuid NOT NULL,
	"sched_in_block" timestamp with time zone NOT NULL,
	"sched_off_block" timestamp with time zone NOT NULL,
	"est_off_block" timestamp with time zone,
	"status" "flight_status" DEFAULT 'scheduled' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ground_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"flight_id" uuid NOT NULL,
	"type" text NOT NULL,
	"sla_minutes" integer NOT NULL,
	"planned_start" timestamp with time zone NOT NULL,
	"planned_end" timestamp with time zone NOT NULL,
	"state" "task_state" DEFAULT 'pending' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replan_scenarios" (
	"id" uuid PRIMARY KEY NOT NULL,
	"flight_id" uuid NOT NULL,
	"proposal_diff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "replan_status" DEFAULT 'proposed' NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"cost_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"stand_type" "stand_type" NOT NULL,
	"constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "stands_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"task_id" uuid NOT NULL,
	"predecessor_task_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_telemetry" (
	"time" timestamp with time zone NOT NULL,
	"task_id" uuid NOT NULL,
	"flight_id" uuid NOT NULL,
	"progress_pct" real NOT NULL,
	"state" "task_state" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_flight_id_flights_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flights" ADD CONSTRAINT "flights_stand_id_stands_id_fk" FOREIGN KEY ("stand_id") REFERENCES "public"."stands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flights" ADD CONSTRAINT "flights_aircraft_type_id_aircraft_types_id_fk" FOREIGN KEY ("aircraft_type_id") REFERENCES "public"."aircraft_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ground_tasks" ADD CONSTRAINT "ground_tasks_flight_id_flights_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replan_scenarios" ADD CONSTRAINT "replan_scenarios_flight_id_flights_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_ground_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."ground_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_predecessor_task_id_ground_tasks_id_fk" FOREIGN KEY ("predecessor_task_id") REFERENCES "public"."ground_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_flight_id_idx" ON "alerts" USING btree ("flight_id");--> statement-breakpoint
CREATE INDEX "alerts_state_idx" ON "alerts" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "applied_events_consumer_aggregate_key" ON "applied_events" USING btree ("consumer_id","aggregate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_id_key" ON "events" USING btree ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_aggregate_sequence_key" ON "events" USING btree ("aggregate_id","sequence");--> statement-breakpoint
CREATE INDEX "events_seq_idx" ON "events" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "events_type_idx" ON "events" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "flights_flight_no_sched_in_block_key" ON "flights" USING btree ("flight_no","sched_in_block");--> statement-breakpoint
CREATE INDEX "ground_tasks_flight_id_idx" ON "ground_tasks" USING btree ("flight_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_dependencies_pk" ON "task_dependencies" USING btree ("task_id","predecessor_task_id");--> statement-breakpoint
CREATE INDEX "task_dependencies_pred_idx" ON "task_dependencies" USING btree ("predecessor_task_id");--> statement-breakpoint
CREATE INDEX "task_telemetry_task_time_idx" ON "task_telemetry" USING btree ("task_id","time");--> statement-breakpoint
-- Custom SQL (data-model.md §2): task_telemetry becomes a TimescaleDB hypertable
-- with compression after 7 days. Forward-only, idempotent via if_not_exists.
CREATE EXTENSION IF NOT EXISTS timescaledb;--> statement-breakpoint
SELECT create_hypertable('task_telemetry', 'time', if_not_exists => TRUE, migrate_data => TRUE);--> statement-breakpoint
ALTER TABLE task_telemetry SET (timescaledb.compress, timescaledb.compress_segmentby = 'task_id');--> statement-breakpoint
SELECT add_compression_policy('task_telemetry', INTERVAL '7 days', if_not_exists => TRUE);