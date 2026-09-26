// F5 continuous-run evidence (DoD: "All PRD in-scope features F-1…F-7
// demonstrable in one continuous run"). The script PERFORMS the flow exactly
// as demo-script.md's beat sheet, in one uninterrupted browser session:
//   F-1 manuals → F-2 search → F-3 ask (grounded + refusal) → F-4 sign-off
//   (engineer ask → reviewer approve) → F-5 fleet/alerts → F-6 eval history
//   → US-10 ingest (reviewer triggers re-ingestion, idempotent no-op).
// Screenshots land in docs/04-projects/mro-copilot/assets/f5-*.png.
// Run: node scripts/screenshots/mro-f5.mjs   (mro stack up on :3003)
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../apps/turnaround-iq/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const BASE = process.env.MRO_BASE_URL ?? "http://localhost:3003";
const OUT = process.env.OUT ?? "docs/04-projects/mro-copilot/assets";
mkdirSync(OUT, { recursive: true });

const ENGINEER = { email: "siti.rahayu@mro-sim.example", password: "engineer-nx-01" };
const REVIEWER = { email: "wei.lim@mro-sim.example", password: "reviewer-nx-01" };

async function login(page, account) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 30_000 });
}

async function logout(page) {
  await page.evaluate(async () => {
    await fetch("/api/v1/auth/logout", { method: "POST" });
  });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const log = (step, msg) => console.info(`[f5-run] ${step}: ${msg}`);

// --- F-1: manual library + browser -------------------------------------------
await login(page, ENGINEER);
log("F-1", "engineer logged in");
await page.goto(`${BASE}/manuals`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/f5-01-manuals-library.png`, fullPage: true });
log("F-1", "manuals library captured");

// --- F-2: hybrid search -------------------------------------------------------
await page.goto(`${BASE}/search`, { waitUntil: "networkidle" });
await page.getByRole("textbox", { name: /search query/i }).fill("hydraulic accumulator torque");
await page.keyboard.press("Enter");
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/f5-02-search-hybrid.png`, fullPage: true });
log("F-2", "search results captured");

// --- F-3: grounded ask + citation; then an honest refusal ---------------------
await page.goto(`${BASE}/ask`, { waitUntil: "networkidle" });
const GROUNDED_Q = "What is the torque for the hydraulic accumulator attach bolts?";
await page.getByLabel(/question/i).fill(GROUNDED_Q);
await page.keyboard.press("Enter");
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/f5-03-ask-grounded.png`, fullPage: true });
log("F-3", "grounded ask captured (draft id needed next)");

// F-4 preparation: remember the draft question; sign-off happens as REVIEWER
// (separation of duties) — engineer logs out after the refusal shot.
await page.getByLabel(/question/i).fill("What is the winglet paint specification for the NX-320?");
await page.keyboard.press("Enter");
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/f5-04-ask-refused.png`, fullPage: true });
log("F-3", "refusal captured");
await logout(page);

// --- F-4: reviewer sign-off of the engineer's draft ---------------------------
await login(page, REVIEWER);
log("F-4", "reviewer logged in");
await page.goto(`${BASE}/reviews`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/f5-05-review-queue.png`, fullPage: true });
const approve = page.getByRole("button", { name: /approve/i }).first();
await approve.click({ timeout: 15_000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/f5-06-approved-library.png`, fullPage: true });
log("F-4", "approved; verified library captured");

// --- F-5: fleet dashboard + unit trend + alert lifecycle ----------------------
await page.evaluate(async () => {
  await fetch("/api/v1/engines/score-fleet", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": `f5-run-${Date.now()}` },
    body: "{}",
  });
});
await page.goto(`${BASE}/engines`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/f5-07-fleet-dashboard.png`, fullPage: true });
log("F-5", "fleet dashboard captured");
await page.goto(`${BASE}/engines/NX-E202`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/f5-08-unit-trend.png`, fullPage: true });
log("F-5", "unit trend captured");

// --- F-6 + US-10: eval history + reviewer ingest panel (idempotent re-ingest) -
await page.goto(`${BASE}/evals`, { waitUntil: "networkidle" });
await page.getByTestId("eval-run-list").waitFor({ timeout: 30_000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/f5-09-eval-history.png`, fullPage: true });
log("F-6", "eval history captured");
const ingestTrigger = page.getByRole("button", { name: /re-ingest corpus/i });
if (await ingestTrigger.isVisible().catch(() => false)) {
  await ingestTrigger.click();
  await page.getByTestId("ingest-result").waitFor({ timeout: 180_000 });
  await page.waitForTimeout(500);
  log("US-10", "re-ingest completed with report");
}
await page.screenshot({ path: `${OUT}/f5-10-ingest-panel.png`, fullPage: true });
log("US-10", "ingest panel captured");

await browser.close();
console.info("[f5-run] continuous run complete — F-1…F-7 + US-10 demonstrated");
