import { defineConfig } from "vitest/config";

/**
 * Integration tests for the web app (engineering-standards.md §3): run against
 * the running compose stack (TIQ_BASE_URL). Never executed by the unit lane.
 * Generous timeouts: `next dev` compiles each API route on first request and a
 * cold container can exceed 30 s for that.
 */
export default defineConfig({
  test: {
    include: ["tests-integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
