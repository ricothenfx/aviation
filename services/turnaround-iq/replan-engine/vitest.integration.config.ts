import { defineConfig } from "vitest/config";

/**
 * Integration tests (engineering-standards.md §3): real PostgreSQL/Redis from the
 * compose stack. DATABASE_URL and REDIS_URL must be provided by the caller —
 * `pnpm test:integration` against the running compose profile.
 */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    // Serial: integration tests share one PostgreSQL + Redis and mutate the log.
    fileParallelism: false,
  },
});
