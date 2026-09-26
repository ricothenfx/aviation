import { defineConfig } from "drizzle-kit";

/**
 * rebook-ai owns its schema + migrations (engineering-standards.md §8: one tool
 * per project — drizzle-kit, same as the other projects; D-08: project-specific
 * domain stays out of shared packages). Targets the `rebook_ai` database in the
 * shared PostgreSQL cluster (rebook-ai data-model.md, ADR-0015).
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.REBOOK_DATABASE_URL ??
      "postgresql://turnaround:turnaround@localhost:5433/rebook_ai",
  },
});
