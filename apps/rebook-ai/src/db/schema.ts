import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * rebook-ai schema — full F2 slice of rebook-ai data-model.md (§1 ERD, §2 table
 * notes). Conventions:
 * - roles are the PRD F-7 ladder: passenger < agent < supervisor (D-09 pattern).
 * - document-shaped payloads (PNR document, offer context, voucher criteria)
 *   use JSONB with GIN indexes (ADR-0015).
 * - event_log is the append-only queue of record (ADR-0014): `processed` /
 *   `attempts` / `process_error` surface poison events honestly
 *   (architecture.md §6, engineering-standards.md §6).
 * - `pnr.user_id` is an F2-additive auth linkage column (D-09): seeded demo
 *   cast PNRs point at their login users so ownership scoping is a UUID
 *   comparison; background synthetic PNRs have no login.
 */

export const userRoleEnum = pgEnum("user_role", ["passenger", "agent", "supervisor"]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  /** Role ladder per PRD F-7: passenger < agent < supervisor (D-09 pattern). */
  role: userRoleEnum("role").notNull().default("passenger"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

// --- reference day (data-model.md §2 flights / §4 seed) ----------------------

export const flightStatusEnum = pgEnum("flight_status", ["scheduled", "delayed", "cancelled"]);

export const flights = pgTable(
  "flights",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Fictional carriers only: NX NordicX, SV Sentosa Air, BH Blue Harbor Air (data-ethics.md §2). */
    airline: text("airline").notNull(),
    flightNo: text("flight_no").notNull(),
    origin: text("origin").notNull(),
    dest: text("dest").notNull(),
    schedDep: timestamp("sched_dep", { withTimezone: true }).notNull(),
    schedArr: timestamp("sched_arr", { withTimezone: true }).notNull(),
    aircraft: text("aircraft").notNull(),
    status: flightStatusEnum("status").notNull().default("scheduled"),
    delayMinutes: integer("delay_minutes").notNull().default(0),
  },
  (table) => [
    uniqueIndex("flights_flight_no_unique").on(table.flightNo),
    index("flights_status_idx").on(table.status),
  ],
);

export type FlightRow = typeof flights.$inferSelect;
export type NewFlightRow = typeof flights.$inferInsert;

// --- bookings (data-model.md §2 pnr / pnr_segments) --------------------------

export const pnrTierEnum = pgEnum("pnr_tier", ["standard", "silver", "gold"]);

export const pnr = pgTable(
  "pnr",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** 6-char fictional record locator — PNR-*like* synthetic booking only. */
    locator: text("locator").notNull().unique(),
    /** Auth linkage (D-09): set for the seeded demo cast, null for background PNRs. */
    userId: uuid("user_id").references(() => users.id),
    passengerName: text("passenger_name").notNull(),
    tier: pnrTierEnum("tier").notNull().default("standard"),
    fareClass: text("fare_class").notNull(),
    /** Fictional contact handle (data-ethics.md §2) — never a real address. */
    contactHandle: text("contact_handle").notNull(),
    partySize: integer("party_size").notNull().default(1),
    /** Deliberately document-shaped payload (ADR-0015): fare rules, SSR flags, loyalty. */
    document: jsonb("document").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pnr_user_idx").on(table.userId),
    index("pnr_document_gin").using("gin", table.document),
  ],
);

export type PnrRow = typeof pnr.$inferSelect;
export type NewPnrRow = typeof pnr.$inferInsert;

export const segmentStatusEnum = pgEnum("segment_status", [
  "confirmed",
  "delayed",
  "cancelled",
  "rebooked",
]);

/** Booked itinerary rows per PNR (data-model.md §2). */
export const pnrSegments = pgTable(
  "pnr_segments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pnrId: uuid("pnr_id")
      .notNull()
      .references(() => pnr.id, { onDelete: "cascade" }),
    airline: text("airline").notNull(),
    flightNo: text("flight_no").notNull(),
    flightDate: timestamp("flight_date", { withTimezone: true }).notNull(),
    origin: text("origin").notNull(),
    dest: text("dest").notNull(),
    cabin: text("cabin").notNull(),
    status: segmentStatusEnum("status").notNull().default("confirmed"),
  },
  (table) => [
    index("pnr_segments_pnr_idx").on(table.pnrId),
    index("pnr_segments_flight_idx").on(table.flightNo),
  ],
);

export type PnrSegmentRow = typeof pnrSegments.$inferSelect;
export type NewPnrSegmentRow = typeof pnrSegments.$inferInsert;

// --- offers (data-model.md §2 offers / offer_options) ------------------------

export const offerStateEnum = pgEnum("offer_state", [
  "proposed",
  "confirmed",
  "expired",
  "superseded",
]);

export const offers = pgTable(
  "offers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pnrId: uuid("pnr_id")
      .notNull()
      .references(() => pnr.id, { onDelete: "cascade" }),
    state: offerStateEnum("state").notNull().default("proposed"),
    /** Disruption snapshot + ranking inputs — explainability (data-model.md §2). */
    context: jsonb("context").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("offers_pnr_state_idx").on(table.pnrId, table.state),
    index("offers_expires_idx").on(table.expiresAt),
    index("offers_context_gin").using("gin", table.context),
  ],
);

export type OfferRow = typeof offers.$inferSelect;
export type NewOfferRow = typeof offers.$inferInsert;

export const optionKindEnum = pgEnum("option_kind", ["fast", "cheap", "flexible"]);

export const offerOptions = pgTable(
  "offer_options",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    kind: optionKindEnum("kind").notNull(),
    /** Human-readable per-rank reason (PRD F-2). */
    reason: text("reason").notNull(),
    /** Priced itinerary incl. partner codes (data-model.md §2). */
    itinerary: jsonb("itinerary").notNull(),
    fareDelta: integer("fare_delta").notNull(),
    /** Supervisor approval gate from F3 (architecture.md §3.3). */
    interline: boolean("interline").notNull().default(false),
  },
  (table) => [uniqueIndex("offer_options_offer_rank_unique").on(table.offerId, table.rank)],
);

export type OfferOptionRow = typeof offerOptions.$inferSelect;
export type NewOfferOptionRow = typeof offerOptions.$inferInsert;

// --- confirmations + sagas (data-model.md §2, ADR-0014) ----------------------

export const rebookRoleColumnEnum = pgEnum("rebook_role", ["passenger", "agent", "supervisor"]);

export const confirmations = pgTable(
  "confirmations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    offerOptionId: uuid("offer_option_id")
      .notNull()
      .references(() => offerOptions.id, { onDelete: "cascade" }),
    pnrId: uuid("pnr_id")
      .notNull()
      .references(() => pnr.id, { onDelete: "cascade" }),
    byUserId: uuid("by_user_id")
      .notNull()
      .references(() => users.id),
    byRole: rebookRoleColumnEnum("by_role").notNull(),
    /** Unique per confirm — the exactly-one-effect key (api-contracts.md §5). */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("confirmations_pnr_idx").on(table.pnrId)],
);

export type ConfirmationRow = typeof confirmations.$inferSelect;
export type NewConfirmationRow = typeof confirmations.$inferInsert;

export const sagaStateEnum = pgEnum("saga_state", [
  "running",
  "completed",
  "failed",
  "compensated",
]);

export const sagas = pgTable(
  "sagas",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pnrId: uuid("pnr_id")
      .notNull()
      .references(() => pnr.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    state: sagaStateEnum("state").notNull().default("running"),
    currentStep: text("current_step"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sagas_pnr_idx").on(table.pnrId), index("sagas_state_idx").on(table.state)],
);

export type SagaRow = typeof sagas.$inferSelect;
export type NewSagaRow = typeof sagas.$inferInsert;

export const sagaStepEnum = pgEnum("saga_step", ["seat_reserve", "payment", "ticket_issue"]);

export const sagaStepStateEnum = pgEnum("saga_step_state", [
  "pending",
  "running",
  "done",
  "failed",
  "compensated",
]);

export const sagaSteps = pgTable(
  "saga_steps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sagaId: uuid("saga_id")
      .notNull()
      .references(() => sagas.id, { onDelete: "cascade" }),
    step: sagaStepEnum("step").notNull(),
    state: sagaStepStateEnum("state").notNull().default("pending"),
    /** Unique per step — idempotent step execution (ADR-0014 §4). */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    /** Simulated PSP/inventory stubs (PRD §4: no real payments). */
    request: jsonb("request"),
    response: jsonb("response"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("saga_steps_saga_state_idx").on(table.sagaId, table.state)],
);

export type SagaStepRow = typeof sagaSteps.$inferSelect;
export type NewSagaStepRow = typeof sagaSteps.$inferInsert;

// --- simulated inventory accounting (data-model.md §2 note, F3 additive) ------

/**
 * DB-backed seats-left counter per rebookable inventory flight (F2 handoff:
 * "seats-left accounting arrives with the F3 saga's seat_reserve step"). The
 * committed inventory fixture stays the *candidate discovery* input (pure
 * ranking, F2 DoD determinism); this table is the *fulfillment* ledger the
 * saga's seat_reserve step decrements transactionally and its compensation
 * restores — exactly-once per saga via the seat_reserve step's unique key.
 */
export const inventorySeats = pgTable("inventory_seats", {
  flightNo: text("flight_no").primaryKey(),
  seatsLeft: integer("seats_left").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type InventorySeatsRow = typeof inventorySeats.$inferSelect;
export type NewInventorySeatsRow = typeof inventorySeats.$inferInsert;

// --- vouchers + notifications (data-model.md §2) -----------------------------

export const voucherStateEnum = pgEnum("voucher_state", ["issued", "used"]);

export const vouchers = pgTable(
  "vouchers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pnrId: uuid("pnr_id")
      .notNull()
      .references(() => pnr.id, { onDelete: "cascade" }),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull().default("SGD"),
    state: voucherStateEnum("state").notNull().default("issued"),
    /** Rule inputs + evaluated values — explainability (PRD F-3). */
    criteria: jsonb("criteria").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("vouchers_pnr_idx").on(table.pnrId),
    index("vouchers_criteria_gin").using("gin", table.criteria),
  ],
);

export type VoucherRow = typeof vouchers.$inferSelect;
export type NewVoucherRow = typeof vouchers.$inferInsert;

export const notificationStateEnum = pgEnum("notification_state", [
  "queued",
  "delivered",
  "failed",
]);

/** In-app inbox rows written by the SNS-shaped publisher (simulated delivery). */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pnrId: uuid("pnr_id")
      .notNull()
      .references(() => pnr.id, { onDelete: "cascade" }),
    channel: text("channel").notNull().default("inbox"),
    state: notificationStateEnum("state").notNull().default("queued"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [index("notifications_pnr_idx").on(table.pnrId)],
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;

// --- proposals (data-model.md §2; consumed from F3) --------------------------

export const proposalSourceEnum = pgEnum("proposal_source", ["llm", "rules"]);
export const proposalStateEnum = pgEnum("proposal_state", ["proposed", "approved", "rejected"]);

export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pnrId: uuid("pnr_id")
      .notNull()
      .references(() => pnr.id, { onDelete: "cascade" }),
    recommendedOptionId: uuid("recommended_option_id").references(() => offerOptions.id, {
      onDelete: "set null",
    }),
    source: proposalSourceEnum("source").notNull(),
    provider: text("provider").notNull(),
    /** Tool-call trace + token usage (PRD F-5, persisted from F3). */
    trace: jsonb("trace"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    state: proposalStateEnum("state").notNull().default("proposed"),
    approverId: uuid("approver_id").references(() => users.id),
    note: text("note"),
    /** Set on approve/reject — decision latency evidence (PRD F-5). */
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("proposals_pnr_idx").on(table.pnrId),
    index("proposals_state_idx").on(table.state),
  ],
);

export type ProposalRow = typeof proposals.$inferSelect;
export type NewProposalRow = typeof proposals.$inferInsert;

// --- event log + audit + idempotency (data-model.md §2) ----------------------

/**
 * Append-only envelope (engineering-standards.md §4). `processed` drives the
 * orchestrator tail (ADR-0014); poison events stay processed=false with an
 * error note and surface in the supervisor console (architecture.md §6).
 */
export const eventLog = pgTable(
  "event_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: text("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    sequence: integer("sequence").notNull(),
    payload: jsonb("payload").notNull(),
    processed: boolean("processed").notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
    processError: text("process_error"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("event_log_aggregate_sequence_unique").on(table.aggregateId, table.sequence),
    index("event_log_processed_idx").on(table.processed, table.id),
  ],
);

export type EventLogRow = typeof eventLog.$inferSelect;
export type NewEventLogRow = typeof eventLog.$inferInsert;

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    actorRole: rebookRoleColumnEnum("actor_role").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_events_created_idx").on(table.createdAt)],
);

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;

/** Replay store for mutating REST (engineering-standards.md §4, data-model.md §2). */
export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  status: integer("status").notNull(),
  responseBody: text("response_body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKeyRow = typeof idempotencyKeys.$inferInsert;
