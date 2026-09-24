import { defineConfig } from "drizzle-kit";

/**
 * mro-copilot owns its schema + migrations (engineering-standards.md §8: one
 * tool per project — drizzle-kit, same as turnaround-iq; D-08: project-specific
 * domain stays out of shared packages). Targets the `mro_copilot` database in
 * the shared PostgreSQL cluster (data-model.md).
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.MRO_DATABASE_URL ??
      "postgresql://turnaround:turnaround@localhost:5433/mro_copilot",
  },
});
