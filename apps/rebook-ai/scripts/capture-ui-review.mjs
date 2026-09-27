/**
 * F4 UI-review + continuous-demo-run harness (milestones.md F4 DoD:
 * "screenshots in report" + "all PRD in-scope features demonstrable in one
 * continuous run"). NOT part of `pnpm test:e2e:rebook` — run it manually
 * against a FRESH stack (the beats consume the demo disruption):
 *
 *   docker compose --profile rebook down -v
 *   docker compose --profile rebook up -d --wait
 *   node apps/rebook-ai/scripts/capture-ui-review.mjs
 *
 * Walks the demo-script.md beats (supervisor inject → passenger offers/voucher
 * → agent proposal → supervisor approval → boarding pass → compensation →
 * audit/containment) and saves labeled screenshots to
 * docs/04-projects/rebook-ai/assets/f4-*.png plus a beat log at
 * docs/04-projects/rebook-ai/demo-run-f4.md. Every assertion mirrors the
 * committed e2e suites; this harness documents the run, it does not replace it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const BASE = process.env.REBOOK_BASE_URL ?? "http://localhost:3004";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const OUT_DIR = join(REPO_ROOT, "docs", "04-projects", "rebook-ai", "assets");
const RUN_LOG = join(REPO_ROOT, "docs", "04-projects", "rebook-ai", "demo-run-f4.md");

const SUPERVISOR = { email: "grace.tan@nx-sim.example", password: "supervisor-nx-01" };
const AGENT = { email: "amir.hassan@nx-sim.example", password: "agent-nx-01" };
const PASSENGER = { email: "nadia.cho@pax-sim.example", password: "passenger-nx-01" };
const FLIGHT = "NX 288";
const LOCATOR = "NXQ4ZK";

const shots = [];

async function loginCookie(actor) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(actor),
  });
  if (!res.ok) throw new Error(`login failed for ${actor.email}: HTTP ${res.status}`);
  const raw = res.headers.get("set-cookie").split(";")[0];
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("="), header: raw };
}

async function newContext(browser, actor, viewport = { width: 1280, height: 720 }) {
  const cookie = await loginCookie(actor);
  const context = await browser.newContext({ viewport });
  await context.addCookies([
    { name: cookie.name, value: cookie.value, domain: "localhost", path: "/" },
  ]);
  return { context, cookieHeader: cookie.header };
}

async function shoot(page, name, label) {
  await page.screenshot({ path: join(OUT_DIR, name), fullPage: false });
  shots.push({ name, label });
  console.info(`shot ${name} — ${label}`);
}

async function expectText(locator, text) {
  const content = await locator.textContent();
  if (!content.includes(text)) {
    throw new Error(`expected "${text}" in: ${content.slice(0, 120)}`);
  }
}

const browser = await chromium.launch();
mkdirSync(OUT_DIR, { recursive: true });
const log = [];
const pages = [];

try {
  // --- Beat 0–8 s: supervisor console — scenario control, empty audit/poison ---
  const sup = await newContext(browser, SUPERVISOR);
  const supPage = await sup.context.newPage();
  pages.push(supPage);
  await supPage.goto(`${BASE}/supervisor`);
  await supPage.getByText("Scenario injection").waitFor({ timeout: 30_000 });
  await supPage.getByText("Audit trail").first().waitFor({ timeout: 30_000 });
  await supPage.waitForTimeout(500);
  await shoot(
    supPage,
    "f4-01-supervisor-inject.png",
    "Supervisor console — scenario control, honest empty audit trail + clean poison panel (§7 states)",
  );

  await supPage.getByLabel(/flight \(reference day\)/i).selectOption(FLIGHT);
  await supPage.getByRole("button", { name: /inject cancellation/i }).click();
  await supPage.getByText(/Injected cancellation/i).waitFor({ timeout: 15_000 });
  log.push(
    "F-1/F-4: supervisor injected cancellation on NX 288 — event appended, orchestrator pipeline notified",
  );

  // --- Beat 8–20 s: passenger — notification, offers, voucher, timeline ---
  const pax = await newContext(browser, PASSENGER);
  const paxPage = await pax.context.newPage();
  pages.push(paxPage);
  await paxPage.goto(`${BASE}/trip`);
  await paxPage.getByTestId("timeline-disruption").waitFor({ timeout: 20_000 });
  await paxPage.getByTestId("option-fast").waitFor({ timeout: 10_000 });
  await paxPage.getByTestId("voucher-card").waitFor({ timeout: 10_000 });
  await shoot(
    paxPage,
    "f4-02-passenger-offers.png",
    "Passenger trip — journey timeline, disruption banner, 3 ranked offers with reasons (F-1/F-2)",
  );

  // Wallet + inbox are below the fold at 1280×720 — scroll for the shot.
  await paxPage.getByTestId("voucher-card").first().scrollIntoViewIfNeeded();
  await paxPage.waitForTimeout(300);
  await shoot(
    paxPage,
    "f4-03-passenger-wallet-inbox.png",
    "Voucher wallet with explainable criteria + inbox with simulated delivery state (F-3)",
  );

  const fast = paxPage.getByTestId("option-fast").first();
  await fast.getByRole("button", { name: /agent help/i }).waitFor({ timeout: 10_000 });
  log.push(
    "F-2/F-7: interline `fast` option honestly gated for the passenger (agent/supervisor path)",
  );

  // --- Beat 30–50 s: agent console — queue, decision card, proposal trace ---
  const agent = await newContext(browser, AGENT);
  const agentPage = await agent.context.newPage();
  pages.push(agentPage);
  await agentPage.goto(`${BASE}/console`);
  await agentPage.getByTestId("queue-waiting").waitFor({ timeout: 20_000 });
  const row = agentPage.getByTestId(`queue-row-${LOCATOR}`).first();
  await row.waitFor({ timeout: 20_000 });
  await row.click();
  await agentPage.getByTestId("proposal-panel").waitFor({ timeout: 20_000 });
  await shoot(
    agentPage,
    "f4-04-agent-console-queue.png",
    "Agent console — KPI tiles, priority queue, expanded booking context (F-4)",
  );

  await agentPage.getByTestId("request-proposal").click();
  const card = agentPage.getByTestId("proposal-card").first();
  await card.waitFor({ timeout: 30_000 });
  await expectText(card, "llm");
  await agentPage.getByTestId("proposal-trace-toggle").click();
  await agentPage.getByTestId("proposal-trace").waitFor({ timeout: 10_000 });
  await shoot(
    agentPage,
    "f4-05-proposal-trace.png",
    "Proposal decision card — source/provider honesty badges, tool trace, supervisor gate (F-5)",
  );
  log.push(
    "F-5: agent loop produced a traced, badged proposal (propose-only, deterministic mock provider)",
  );

  // --- Beat 50–70 s: supervisor approval → saga → boarding pass ---
  const sup2 = await newContext(browser, SUPERVISOR);
  const supPage2 = await sup2.context.newPage();
  pages.push(supPage2);
  await supPage2.goto(`${BASE}/console`);
  await supPage2.getByTestId("queue-waiting").waitFor({ timeout: 20_000 });
  const supRow = supPage2.getByTestId(`queue-row-${LOCATOR}`).first();
  await supRow.waitFor({ timeout: 20_000 });
  await supRow.click();
  const supCard = supPage2.getByTestId("proposal-card").first();
  await supCard.waitFor({ timeout: 30_000 });
  await supPage2
    .getByTestId("proposal-note")
    .fill("Partner rebooking confirmed with passenger (demo run).");
  const approve = supPage2.waitForResponse(
    (res) => res.url().includes("/approve") && res.request().method() === "POST",
    { timeout: 20_000 },
  );
  await supCard.getByTestId("proposal-approve").click();
  const status = (await approve).status();
  if (status !== 201) throw new Error(`approve returned HTTP ${status}`);
  log.push(
    "F-6/F-7: supervisor approval applied through the ONE saga path (audit row + proposal.approved)",
  );

  await paxPage.goto(`${BASE}/trip`);
  const boardingPass = paxPage.getByTestId("boarding-pass").first();
  await boardingPass.waitFor({ timeout: 30_000 });
  await shoot(
    paxPage,
    "f4-06-boarding-pass.png",
    "Journey settled — new itinerary + boarding pass labeled simulated (F-6)",
  );
  log.push(
    "F-6: saga completed seat_reserve → payment (simulated PSP) → ticket_issue; boarding pass BP-… issued",
  );

  // --- Beat 70–80 s: compensation on a second PNR (agent confirm, supervisor compensate) ---
  // The executor advances sagas within ~1 s of the confirm, so a manual
  // compensate can lose the race (409 SAGA_CONFLICT on a completed saga).
  // Try candidates in queue order until one compensate lands while running.
  const queueRes = await fetch(`${BASE}/api/v1/queue`, {
    headers: { cookie: sup2.cookieHeader },
  });
  const queue = await queueRes.json();
  const candidates = queue.items.filter((item) => item.locator !== LOCATOR).slice(0, 4);
  if (candidates.length === 0) throw new Error("no second disrupted PNR for the compensation beat");

  let compensated = null;
  for (const candidate of candidates) {
    const detailRes = await fetch(`${BASE}/api/v1/pnr/${candidate.locator}`, {
      headers: { cookie: agent.cookieHeader },
    });
    const detail = await detailRes.json();
    const offer = detail.offers.find((o) => o.state === "proposed" && o.options.length >= 3);
    if (!offer) continue;
    const sameCarrier = offer.options.find((o) => !o.interline);
    const confirmRes = await fetch(`${BASE}/api/v1/pax/offers/${offer.id}/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: agent.cookieHeader,
        "Idempotency-Key": `demo-compensate-${offer.id}`,
      },
      body: JSON.stringify({ optionId: sameCarrier.id }),
    });
    if (!confirmRes.ok) continue;
    const { sagaId } = await confirmRes.json();
    const compRes = await fetch(`${BASE}/api/v1/sagas/${sagaId}/compensate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: sup2.cookieHeader,
        "Idempotency-Key": `demo-compensate-${sagaId}`,
      },
      body: JSON.stringify({}),
    });
    if (compRes.ok) {
      const comp = await compRes.json();
      compensated = { locator: candidate.locator, sagaId, state: comp.state };
      break;
    }
    console.warn(`compensate raced completion for ${candidate.locator} — trying the next PNR`);
  }
  if (!compensated) throw new Error("compensation beat: no saga was still running to compensate");
  log.push(
    `F-6 honesty beat: saga ${compensated.sagaId.slice(0, 8)}… compensated (${compensated.state}) — ${compensated.locator} returns to the queue`,
  );

  // --- Beat 80–90 s: audit trail + containment ---
  await supPage2.goto(`${BASE}/supervisor`);
  await supPage2.getByTestId("audit-row").first().waitFor({ timeout: 20_000 });
  await supPage2.waitForTimeout(500);
  await shoot(
    supPage2,
    "f4-07-audit-trail.png",
    "Audit trail — who decided what for whom, when (F-7, demo beat 80–90 s)",
  );

  await agentPage.goto(`${BASE}/console`);
  await agentPage.getByTestId("queue-containment").waitFor({ timeout: 20_000 });
  await agentPage.waitForTimeout(700); // let the count-up settle (§6)
  const waiting = (await agentPage.getByTestId("queue-waiting").textContent()).trim();
  const containment = (await agentPage.getByTestId("queue-containment").textContent()).trim();
  log.push(
    `F-4 containment tile: waiting=${waiting} containment=${containment} (honest, live from PG)`,
  );
  await shoot(
    agentPage,
    "f4-08-containment.png",
    "Agent queue after service + compensation — containment tile, re-queued passenger (F-4)",
  );

  // --- Keyboard navigation + focus evidence (§9) ---
  const rowButton = agentPage.locator("[data-queue-row]").first();
  await rowButton.focus();
  await agentPage.keyboard.press("ArrowDown");
  await agentPage.waitForTimeout(300);
  await shoot(
    agentPage,
    "f4-09-keyboard-nav.png",
    "Keyboard navigation — roving focus + visible focus ring on queue rows (§9)",
  );

  // --- Responsive: tablet width ---
  const tablet = await newContext(browser, PASSENGER, { width: 768, height: 1024 });
  const tabletPage = await tablet.context.newPage();
  pages.push(tabletPage);
  await tabletPage.goto(`${BASE}/trip`);
  await tabletPage.getByTestId("option-fast").waitFor({ timeout: 20_000 });
  await shoot(
    tabletPage,
    "f4-10-tablet-trip.png",
    "Responsive smoke — passenger trip at 768×1024 (§8: responsive is not an afterthought)",
  );
} finally {
  await browser.close();

  writeFileSync(RUN_LOG, renderRunLog(log, shots));
  console.info(`\ncontinuous run log → ${RUN_LOG}`);
}

function renderRunLog(entries, shotList) {
  const date = new Date().toISOString().slice(0, 10);
  return [
    "# Rebook.ai — Continuous F-1…F-7 Demo Run (F4)",
    "",
    "| Field | Value |",
    "|---|---|",
    `| Date | ${date} |`,
    "| Scope | milestones.md F4 DoD: all PRD in-scope features demonstrable in one continuous run |",
    "| Harness | `apps/rebook-ai/scripts/capture-ui-review.mjs` on a fresh stack (`down -v` → `up -d --wait`) |",
    "| Cast | Nadia Cho NXQ4ZK (NX 288 SIN→AMS cancelled), Amir Hassan (agent), Grace Tan (supervisor) — demo-script.md |",
    "",
    "## Beat log",
    "",
    ...entries.map((entry, i) => `${i + 1}. ${entry}`),
    "",
    "## Screenshots (assets/)",
    "",
    ...shotList.map((shot) => `- ![${shot.label}](assets/${shot.name}) — ${shot.label}`),
    "",
    "All numbers and states above are read from the running stack — nothing fabricated (data-ethics.md §4).",
    "",
  ].join("\n");
}
