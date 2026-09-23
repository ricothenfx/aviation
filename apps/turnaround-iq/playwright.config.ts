import { defineConfig, devices } from "@playwright/test";

/**
 * E2E configuration (milestones.md §F3 DoD): runs against the full compose stack
 * (web on :3001, gateway ws on :4001) — boot it first:
 *   docker compose --profile turnaround up -d --wait
 * The spec drives seed → inject disruption → alert → replan → approve → board.
 */
export default defineConfig({
  testDir: "./e2e",
  // The scenario runs at 20×: the first live baggage_load appears ~4.5 min into
  // the reference day — the full flow needs a generous budget.
  timeout: 600_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.TIQ_E2E_BASE_URL ?? "http://localhost:3001",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 720 },
  },
});
