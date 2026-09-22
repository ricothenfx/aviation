import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Full turnaround-iq schema (data-model.md §1–2, F2 milestone scope).
 * Conventions:
 * - `flights.est_off_block` and `ground_tasks.state` are PROJECTIONS (ADR-0001) —
 *   rebuilt from event_log, never hand-edited at runtime.
 * - `events` is append-only: the unique index (aggregate_id, sequence) is the
 *   idempotency key (ADR-0001); no UPDATE/DELETE happens in any code path.
 */

export const userRoleEnum = pgEnum("user_role", ["viewer", "coordinator", "supervisor"]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  role: userRoleEnum("role").notNull().default("viewer"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export const standTypeEnum = pgEnum("stand_type", ["narrow", "wide"]);

export const stands = pgTable("stands", {
  id: uuid("id").primaryKey(),
  code: text("code").notNull().unique(),
  standType: standTypeEnum("stand_type").notNull(),
  constraints: jsonb("constraints").notNull().default({}),
});

export type StandRow = typeof stands.$inferSelect;
export type NewStandRow = typeof stands.$inferInsert;

export const aircraftTypes = pgTable("aircraft_types", {
  id: uuid("id").primaryKey(),
  code: text("code").notNull().unique(),
  turnSlaDefaults: jsonb("turn_sla_defaults").notNull().default({}),
});

export type AircraftTypeRow = typeof aircraftTypes.$inferSelect;
export type NewAircraftTypeRow = typeof aircraftTypes.$inferInsert;

// ---------------------------------------------------------------------------
// Flights & ground tasks
// ---------------------------------------------------------------------------

export const flightStatusEnum = pgEnum("flight_status", [
  "scheduled",
  "in_block",
  "turnaround",
  "off_block",
  "delayed",
]);

export const flights = pgTable(
  "flights",
  {
    id: uuid("id").primaryKey(),
    flightNo: text("flight_no").notNull(),
    standId: uuid("stand_id")
      .notNull()
      .references(() => stands.id),
    aircraftTypeId: uuid("aircraft_type_id")
      .notNull()
      .references(() => aircraftTypes.id),
    schedInBlock: timestamp("sched_in_block", { withTimezone: true }).notNull(),
    schedOffBlock: timestamp("sched_off_block", { withTimezone: true }).notNull(),
    /** Projection-maintained (data-model.md §2) — rebuilt from events. */
    estOffBlock: timestamp("est_off_block", { withTimezone: true }),
    status: flightStatusEnum("status").notNull().default("scheduled"),
  },
  (table) => [
    uniqueIndex("flights_flight_no_sched_in_block_key").on(table.flightNo, table.schedInBlock),
  ],
);

export type FlightRow = typeof flights.$inferSelect;
export type NewFlightRow = typeof flights.$inferInsert;

export const taskStateEnum = pgEnum("task_state", ["pending", "in_progress", "done", "blocked"]);

export const groundTasks = pgTable(
  "ground_tasks",
  {
    id: uuid("id").primaryKey(),
    flightId: uuid("flight_id")
      .notNull()
      .references(() => flights.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    slaMinutes: integer("sla_minutes").notNull(),
    plannedStart: timestamp("planned_start", { withTimezone: true }).notNull(),
    plannedEnd: timestamp("planned_end", { withTimezone: true }).notNull(),
    /** Projection-maintained (data-model.md §2) — rebuilt from events. */
    state: taskStateEnum("state").notNull().default("pending"),
    /** Document-shaped data (unit assignments, constraint hints) — ADR-0002 story. */
    config: jsonb("config").notNull().default({}),
  },
  (table) => [index("ground_tasks_flight_id_idx").on(table.flightId)],
);

export type GroundTaskRow = typeof groundTasks.$inferSelect;
export type NewGroundTaskRow = typeof groundTasks.$inferInsert;

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => groundTasks.id, { onDelete: "cascade" }),
    predecessorTaskId: uuid("predecessor_task_id")
      .notNull()
      .references(() => groundTasks.id, { onDelete: "cascade" }),
  },
  (table) => [
    // Cycle checks happen at insert time in the seed/simulator (data-model.md §2).
    uniqueIndex("task_dependencies_pk").on(table.taskId, table.predecessorTaskId),
    index("task_dependencies_pred_idx").on(table.predecessorTaskId),
  ],
);

export type TaskDependencyRow = typeof taskDependencies.$inferSelect;
export type NewTaskDependencyRow = typeof taskDependencies.$inferInsert;

// ---------------------------------------------------------------------------
// Event log + projection watermarks (ADR-0001)
// ---------------------------------------------------------------------------

export const aggregateTypeEnum = pgEnum("aggregate_type", [
  "flight",
  "task",
  "alert",
  "replan",
  "scenario",
]);

export const eventProducerEnum = pgEnum("event_producer", [
  "simulator",
  "replan_engine",
  "user_action",
]);

export const events = pgTable(
  "events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    id: text("id").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    aggregateType: aggregateTypeEnum("aggregate_type").notNull(),
    type: text("type").notNull(),
    /** Monotonic per aggregate — the idempotency key half (ADR-0001). */
    sequence: integer("sequence").notNull(),
    /** Scenario time, not wall time (architecture.md §4). */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").notNull(),
    producer: eventProducerEnum("producer").notNull(),
  },
  (table) => [
    uniqueIndex("events_id_key").on(table.id),
    uniqueIndex("events_aggregate_sequence_key").on(table.aggregateId, table.sequence),
    index("events_seq_idx").on(table.seq),
    index("events_type_idx").on(table.type),
  ],
);

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;

export const appliedEvents = pgTable(
  "applied_events",
  {
    consumerId: text("consumer_id").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    lastSequence: integer("last_sequence").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("applied_events_consumer_aggregate_key").on(table.consumerId, table.aggregateId),
  ],
);

export type AppliedEventRow = typeof appliedEvents.$inferSelect;
export type NewAppliedEventRow = typeof appliedEvents.$inferInsert;

// ---------------------------------------------------------------------------
// Alerts & replans (schemas land in F2; producers arrive in F3)
// ---------------------------------------------------------------------------

export const alertSeverityEnum = pgEnum("alert_severity", ["info", "warning", "critical"]);
export const alertStateEnum = pgEnum("alert_state", ["raised", "acknowledged", "resolved"]);
export const replanStatusEnum = pgEnum("replan_status", ["proposed", "approved", "rejected"]);

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey(),
    flightId: uuid("flight_id")
      .notNull()
      .references(() => flights.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull(),
    severity: alertSeverityEnum("severity").notNull(),
    state: alertStateEnum("state").notNull().default("raised"),
    /** Scenario time stamps (architecture.md §4). */
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    detail: jsonb("detail").notNull().default({}),
  },
  (table) => [
    index("alerts_flight_id_idx").on(table.flightId),
    index("alerts_state_idx").on(table.state),
  ],
);

export type AlertRow = typeof alerts.$inferSelect;
export type NewAlertRow = typeof alerts.$inferInsert;

export const replanScenarios = pgTable("replan_scenarios", {
  id: uuid("id").primaryKey(),
  flightId: uuid("flight_id")
    .notNull()
    .references(() => flights.id, { onDelete: "cascade" }),
  proposalDiff: jsonb("proposal_diff").notNull().default({}),
  status: replanStatusEnum("status").notNull().default("proposed"),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
  costBreakdown: jsonb("cost_breakdown").notNull().default({}),
});

export type ReplanScenarioRow = typeof replanScenarios.$inferSelect;
export type NewReplanScenarioRow = typeof replanScenarios.$inferInsert;

// ---------------------------------------------------------------------------
// Task telemetry (TimescaleDB hypertable — data-model.md §2)
// ---------------------------------------------------------------------------

export const taskTelemetry = pgTable(
  "task_telemetry",
  {
    /** Hypertable partition column (custom SQL in migration 0001). */
    time: timestamp("time", { withTimezone: true }).notNull(),
    taskId: uuid("task_id").notNull(),
    flightId: uuid("flight_id").notNull(),
    progressPct: real("progress_pct").notNull(),
    state: taskStateEnum("state").notNull(),
  },
  (table) => [index("task_telemetry_task_time_idx").on(table.taskId, table.time)],
);

export type TaskTelemetryRow = typeof taskTelemetry.$inferSelect;
export type NewTaskTelemetryRow = typeof taskTelemetry.$inferInsert;
