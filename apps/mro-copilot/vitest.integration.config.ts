import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Integration tests (engineering-standards.md §3): run against the running
 * compose profile "mro" stack (DATABASE_URL + MRO_AI_SERVICE_URL). Never
 * executed by the unit lane. Generous timeouts: `next dev` compiles each API
 * route on first request and a cold container can exceed 30 s for that.
 */
export default defineConfig({
  test: {
    include: ["tests-integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
});
