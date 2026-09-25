// F2 UI evidence screenshots (ui-design-system.md §7 states).
// Run: node scripts/screenshots/mro-f2.mjs   (mro stack must be up on :3003)
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
await page.getByLabel("Email").fill("tom.ng@mro-sim.example");
await page.getByLabel("Password").fill("viewer-nx-01");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL(`${BASE}/`, { timeout: 30000 });

// Manuals browser: open an ATA 29 task card and select a chunk
await page.goto(`${BASE}/manuals`, { waitUntil: "networkidle" });
await page
  .getByRole("button", { name: /power transfer unit/ })
  .first()
  .click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/f2-manuals-chunk.png` });

// Search with results (hybrid mode badge + highlighted snippets)
await page.goto(`${BASE}/search`, { waitUntil: "networkidle" });
await page.getByLabel("Search query").fill("torque the accumulator attach bolts");
await page.getByRole("button", { name: /search/i }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/f2-search-hybrid.png` });

await browser.close();
console.info(`screenshots written to ${OUT}`);
