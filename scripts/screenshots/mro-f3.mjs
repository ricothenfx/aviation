// F3 UI evidence screenshots (ui-design-system.md §5/§7/§8 review).
// Run: node scripts/screenshots/mro-f3.mjs   (mro stack must be up on :3003)
// Playwright is resolved from apps/turnaround-iq (the workspace's e2e home).
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../apps/turnaround-iq/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const BASE = process.env.MRO_BASE_URL ?? "http://localhost:3003";
const OUT = process.env.OUT ?? "docs/04-projects/mro-copilot/assets";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.getByLabel("Email").fill("siti.rahayu@mro-sim.example");
await page.getByLabel("Password").fill("engineer-nx-01");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL(`${BASE}/`, { timeout: 30000 });

// Ask panel: grounded draft with citations, source badge, retrieval mode
await page.goto(`${BASE}/ask`, { waitUntil: "networkidle" });
await page
  .getByLabel("Maintenance question")
  .fill(
    "What torque applies to the cabin pressure outflow valve attach bolts during installation?",
  );
await page.getByRole("button", { name: "Ask" }).click();
await page.getByTestId("draft-card").waitFor({ timeout: 30000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/f3-ask-draft.png` });

// Ask panel: honest refusal with machine-readable reason
await page
  .getByLabel("Maintenance question")
  .fill("What is the bleed duct torque for the HX-200 regional jet?");
await page.getByRole("button", { name: "Ask" }).click();
await page.getByTestId("refusal-card").waitFor({ timeout: 30000 });
await page.screenshot({ path: `${OUT}/f3-ask-refusal.png` });

// Reviewer: review queue with citations side-by-side + reject note open
await page.getByRole("button", { name: "Sign out" }).click();
await page.waitForURL(/\/login/);
await page.getByLabel("Email").fill("wei.lim@mro-sim.example");
await page.getByLabel("Password").fill("reviewer-nx-01");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL(`${BASE}/`, { timeout: 30000 });
await page.goto(`${BASE}/reviews`, { waitUntil: "networkidle" });
await page.getByTestId("queue-item").first().waitFor({ timeout: 30000 });
const item = page.getByTestId("queue-item").first();
await item.getByTestId("reject-toggle").click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/f3-review-queue.png` });

// Verified library (approved answers with sign-off block)
await page.goto(`${BASE}/answers`, { waitUntil: "networkidle" });
await page.getByRole("tab", { name: "Verified library" }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/f3-answers-library.png` });

// Eval dashboard gate history
await page.goto(`${BASE}/evals`, { waitUntil: "networkidle" });
await page
  .getByTestId("eval-run-list")
  .waitFor({ timeout: 30000 })
  .catch(() => {});
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/f3-evals-history.png` });

await browser.close();
console.info(`screenshots written to ${OUT}`);
