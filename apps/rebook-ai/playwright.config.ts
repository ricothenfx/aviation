import { defineConfig, devices } from "@playwright/test";

/**
 * E2E configuration (milestones.md F2 DoD): runs against the rebook compose
 * stack (web on :3004) — boot it first:
 *   docker compose --profile rebook up -d --wait
 * For a fully deterministic journey, start from a fresh database:
 *   docker compose --profile rebook down -v && docker compose --profile rebook up -d --wait
 * The spec drives supervisor inject → passenger notification → one-tap confirm
 * → saga (stub steps) visible.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.REBOOK_E2E_BASE_URL ?? "http://localhost:3004",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 720 },
  },
});
