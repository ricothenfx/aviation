import { defineConfig, devices } from "@playwright/test";

/**
 * mro-copilot E2E configuration (milestones.md §F3 DoD): runs against the
 * compose stack (web on :3003) — boot it first:
 *   docker compose --profile mro up -d --wait
 * The spec drives login → ask → citation into the manual browser → reviewer
 * approve → answer in the verified library, plus the refusal contract.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.MRO_E2E_BASE_URL ?? "http://localhost:3003",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 720 },
  },
});
