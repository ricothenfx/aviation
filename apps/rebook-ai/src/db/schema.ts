import { boolean, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * rebook-ai schema — F1 slice of rebook-ai data-model.md (§1 ERD, §2 table
 * notes). Domain tables (flights, pnr, offers, sagas, vouchers, notifications,
 * proposals, event_log, audit_events, idempotency_keys) arrive with F2/F3 as
 * additive forward-only migrations. Conventions:
 * - roles are the PRD F-7 ladder: passenger < agent < supervisor (D-09 pattern).
 * - document-shaped payloads (PNR document, offer context, voucher criteria)
 *   will use JSONB with GIN indexes (ADR-0015) — introduced with their tables.
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
