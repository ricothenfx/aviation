import { defineConfig } from "vitest/config";

/**
 * Integration tests: run against the running compose profile "rebook" stack
 * (REBOOK_DATABASE_URL + REDIS_URL). Never executed by the unit lane.
 */
export default defineConfig({
  test: {
    include: ["tests-integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
