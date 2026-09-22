import { boolean, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * F1 schema scope: users for auth (D-09, data-model.md §2).
 * The full turnaround schema (flights, tasks, event_log, …) lands in F2 migrations
 * per the F2 milestone scope — no scope jumping.
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
