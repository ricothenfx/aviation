// F4 UI evidence screenshots (ui-design-system.md §5/§7/§8 review).
// Run: node scripts/screenshots/mro-f4.mjs   (mro stack must be up on :3003)
// Playwright is resolved from apps/turnaround-iq (the workspace's e2e home).
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../apps/turnaround-iq/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const BASE = process.env.MRO_BASE_URL ?? "http://localhost:3003";
const OUT = process.env.OUT ?? "docs/04-projects/mro-copilot/assets";
mkdirSync(OUT, { recursive: true });

const ENGINEER = { email: "siti.rahayu@mro-sim.example", password: "engineer-nx-01" };

async function login(page, account) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 30_000 });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

await login(page, ENGINEER);

// Ensure the fleet is scored and an alert fixture is open (NX-E202 crossing).
await page.goto(`${BASE}/api/v1/auth/me`, { waitUntil: "networkidle" }); // warm session
await page.evaluate(async () => {
  await fetch("/api/v1/engines/score-fleet", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": `shot-${Date.now()}` },
    body: "{}",
  });
});

// Fleet dashboard: KPI tiles, provenance strip, fleet table (— honesty case),
// alert queue. Full page to include the footer + citation.
await page.goto(`${BASE}/engines`, { waitUntil: "networkidle" });
await page.getByTestId("fleet-table").waitFor({ timeout: 30_000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/f4-fleet-dashboard.png`, fullPage: true });

// Unit detail: RUL trend with uncertainty band + labeled axes + threshold line.
await page.goto(`${BASE}/engines/NX-E202`, { waitUntil: "networkidle" });
await page.getByTestId("trend-chart").waitFor({ timeout: 30_000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/f4-unit-trend.png`, fullPage: true });

// Alert lifecycle panel (open alert with actions; history below).
await page.goto(`${BASE}/engines`, { waitUntil: "networkidle" });
await page.getByTestId("alert-item").first().waitFor({ timeout: 30_000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/f4-alerts.png` });

await browser.close();
console.info(`screenshots written to ${OUT}`);
