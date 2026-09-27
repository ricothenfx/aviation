/**
 * F5 continuous demo-run harness (milestones.md F5 DoD: "fresh 90 s demo video
 * per demo-script.md" — the recording itself is a human step; this harness
 * executes the same beat sheet against a fresh stack and commits the evidence:
 * timed beats, screenshots, and the F4 handoff's self-serve containment beat).
 * NOT part of `pnpm test:e2e:rebook` — run manually against a FRESH stack:
 *
 *   docker compose --profile rebook down -v
 *   docker compose --profile rebook up -d --wait
 *   node apps/rebook-ai/scripts/capture-demo-f5.mjs
 *
 * Differences from the F4 harness (scripts/capture-ui-review.mjs):
 * - the passenger SELF-SERVES the same-carrier `cheap` option (the F4 handoff
 *   note: a passenger-role confirm raises the containment tile above 0%);
 * - every beat carries its wall-clock time against the demo-script.md 90 s
 *   beat sheet;
 * - the agent-loop proposal beat runs on a second PNR (NXQ4ZK self-served).
 * Every assertion mirrors the committed e2e suites; this harness documents the
 * run, it does not replace it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const BASE = process.env.REBOOK_BASE_URL ?? "http://localhost:3004";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const OUT_DIR = join(REPO_ROOT, "docs", "04-projects", "rebook-ai", "assets");
const RUN_LOG = join(REPO_ROOT, "docs", "04-projects", "rebook-ai", "demo-run-f5.md");

const SUPERVISOR = { email: "grace.tan@nx-sim.example", password: "supervisor-nx-01" };
const AGENT = { email: "amir.hassan@nx-sim.example", password: "agent-nx-01" };
const PASSENGER = { email: "nadia.cho@pax-sim.example", password: "passenger-nx-01" };
const FLIGHT = "NX 288";
const LOCATOR = "NXQ4ZK";

const shots = [];
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

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
  // --- Beat 0–8 s: supervisor injects the cancellation; queue populates ---
  const sup = await newContext(browser, SUPERVISOR);
  const supPage = await sup.context.newPage();
  pages.push(supPage);
  await supPage.goto(`${BASE}/supervisor`);
  await supPage.getByText("Scenario injection").waitFor({ timeout: 30_000 });
  await supPage.getByText("Audit trail").first().waitFor({ timeout: 30_000 });
  await shoot(
    supPage,
    "f5-01-supervisor-inject.png",
    "Supervisor console — scenario control, empty audit trail + clean poison panel",
  );

  await supPage.getByLabel(/flight \(reference day\)/i).selectOption(FLIGHT);
  await supPage.getByRole("button", { name: /inject cancellation/i }).click();
  await supPage.getByText(/Injected cancellation/i).waitFor({ timeout: 15_000 });
  log.push(
    `[${elapsed()}] beat 0–8 s: cancellation injected on ${FLIGHT} (proactive pipeline notified)`,
  );

  // --- Beat 8–20 s: passenger sees notification + ranked offers + voucher ---
  const pax = await newContext(browser, PASSENGER);
  const paxPage = await pax.context.newPage();
  pages.push(paxPage);
  await paxPage.goto(`${BASE}/trip`);
  await paxPage.getByTestId("timeline-disruption").waitFor({ timeout: 20_000 });
  await paxPage.getByTestId("option-fast").waitFor({ timeout: 10_000 });
  await paxPage.getByTestId("voucher-card").waitFor({ timeout: 10_000 });
  await shoot(
    paxPage,
    "f5-02-passenger-offers.png",
    "Passenger trip — timeline, disruption banner, 3 ranked offers with reasons",
  );
  log.push(
    `[${elapsed()}] beat 8–20 s: notification + 3 ranked offers + voucher visible for ${LOCATOR}`,
  );

  // --- Beat 20–30 s: PASSENGER self-serves the same-carrier cheap option ---
  const cheap = paxPage.getByTestId("option-cheap").first();
  const confirmBtn = cheap.getByRole("button", { name: /^confirm$/i });
  await confirmBtn.waitFor({ timeout: 10_000 });
  await cheap.scrollIntoViewIfNeeded();
  await shoot(
    paxPage,
    "f5-03-self-serve-confirm.png",
    "One-tap self-serve confirm on the same-carrier option (no agent queue minute spent)",
  );
  await confirmBtn.click();
  await paxPage.getByTestId(`saga-step-seat_reserve`).waitFor({ timeout: 20_000 });
  log.push(
    `[${elapsed()}] beat 20–30 s: passenger confirmed the cheap option — saga opened (self-serve)`,
  );
  await paxPage.getByTestId("boarding-pass").first().waitFor({ timeout: 30_000 });
  await shoot(
    paxPage,
    "f5-04-boarding-pass-self-serve.png",
    "Saga completed live — new itinerary + boarding pass, labeled simulated",
  );
  log.push(
    `[${elapsed()}] beat 30–50 s: saga landed seat_reserve → payment (simulated PSP) → ticket_issue; boarding pass issued to the PASSENGER (containment beat)`,
  );

  // --- Beat 30–50 s: agent loop proposes for a second PNR (propose-only) ---
  const agent = await newContext(browser, AGENT);
  const agentPage = await agent.context.newPage();
  pages.push(agentPage);
  await agentPage.goto(`${BASE}/console`);
  await agentPage.getByTestId("queue-waiting").waitFor({ timeout: 20_000 });
  const queueRes = await fetch(`${BASE}/api/v1/queue`, { headers: { cookie: agent.cookieHeader } });
  const queue = await queueRes.json();
  const second = queue.items.find((item) => item.locator !== LOCATOR);
  if (!second) throw new Error("no second disrupted PNR for the agent-loop beat");
  const row = agentPage.getByTestId(`queue-row-${second.locator}`).first();
  await row.waitFor({ timeout: 20_000 });
  await row.click();
  await agentPage.getByTestId("proposal-panel").waitFor({ timeout: 20_000 });
  await shoot(
    agentPage,
    "f5-05-agent-console.png",
    `Agent console — live queue (NXQ4ZK already served), ${second.locator} expanded`,
  );
  await agentPage.getByTestId("request-proposal").click();
  const card = agentPage.getByTestId("proposal-card").first();
  await card.waitFor({ timeout: 30_000 });
  await expectText(card, "llm");
  await agentPage.getByTestId("proposal-trace-toggle").click();
  await agentPage.getByTestId("proposal-trace").waitFor({ timeout: 10_000 });
  await shoot(
    agentPage,
    "f5-06-proposal-trace.png",
    "Traced, badged proposal (source: llm / provider: mock) — propose-only until approved",
  );
  log.push(
    `[${elapsed()}] beat 30–50 s: agent loop produced a traced proposal for ${second.locator} (propose-only)`,
  );

  // --- Beat 50–70 s: supervisor approval → saga for the second PNR ---
  const sup2 = await newContext(browser, SUPERVISOR);
  const supPage2 = await sup2.context.newPage();
  pages.push(supPage2);
  await supPage2.goto(`${BASE}/console`);
  await supPage2.getByTestId("queue-waiting").waitFor({ timeout: 20_000 });
  const supRow = supPage2.getByTestId(`queue-row-${second.locator}`).first();
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
    `[${elapsed()}] beat 50–70 s: supervisor approval applied through the ONE saga path (no side door)`,
  );

  // --- Beat 70–80 s: honesty beat — compensation returns a passenger to the queue ---
  const queueRes2 = await fetch(`${BASE}/api/v1/queue`, { headers: { cookie: sup2.cookieHeader } });
  const queue2 = await queueRes2.json();
  const candidates = queue2.items.filter((item) => item.locator !== LOCATOR).slice(0, 4);
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
    `[${elapsed()}] beat 70–80 s: saga ${compensated.sagaId.slice(0, 8)}… compensated (${compensated.state}) — ${compensated.locator} honestly back in the queue`,
  );

  // --- Beat 80–90 s: audit trail + self-serve containment (> 0%) ---
  await supPage2.goto(`${BASE}/supervisor`);
  await supPage2.getByTestId("audit-row").first().waitFor({ timeout: 20_000 });
  await supPage2.waitForTimeout(500);
  await shoot(
    supPage2,
    "f5-07-audit-trail.png",
    "Audit trail — who decided what for whom, when (demo beat 80–90 s)",
  );

  await agentPage.goto(`${BASE}/console`);
  await agentPage.getByTestId("queue-containment").waitFor({ timeout: 20_000 });
  await agentPage.waitForTimeout(700); // let the count-up settle (§6)
  const waiting = (await agentPage.getByTestId("queue-waiting").textContent()).trim();
  const containment = (await agentPage.getByTestId("queue-containment").textContent()).trim();
  log.push(
    `[${elapsed()}] beat 80–90 s: queue waiting=${waiting}, containment=${containment} (self-serve NXQ4ZK confirmed → > 0%)`,
  );
  await shoot(
    agentPage,
    "f5-08-containment.png",
    "Containment tile above 0% thanks to the passenger self-serve confirm + re-queued compensation passenger",
  );
  if (/^0%$/.test(containment)) {
    throw new Error(
      `containment stayed 0% — the self-serve beat did not register (${waiting} waiting)`,
    );
  }

  // --- Keyboard navigation + responsive parity with the F4 evidence ---
  const rowButton = agentPage.locator("[data-queue-row]").first();
  await rowButton.focus();
  await agentPage.keyboard.press("ArrowDown");
  await agentPage.waitForTimeout(300);
  await shoot(
    agentPage,
    "f5-09-keyboard-nav.png",
    "Keyboard navigation — roving focus + visible focus ring on queue rows (§9)",
  );

  const tablet = await newContext(browser, PASSENGER, { width: 768, height: 1024 });
  const tabletPage = await tablet.context.newPage();
  pages.push(tabletPage);
  await tabletPage.goto(`${BASE}/trip`);
  await tabletPage.getByTestId("trip-timeline").waitFor({ timeout: 20_000 });
  await shoot(
    tabletPage,
    "f5-10-tablet-trip.png",
    "Responsive smoke — passenger trip (settled itinerary) at 768×1024",
  );
  log.push(`[${elapsed()}] total wall clock for the full beat sheet (fresh stack, real pipeline)`);
} finally {
  await browser.close();
  writeFileSync(RUN_LOG, renderRunLog(log, shots));
  console.info(`\ncontinuous run log → ${RUN_LOG}`);
}

function renderRunLog(entries, shotList) {
  const date = new Date().toISOString().slice(0, 10);
  return [
    "# Rebook.ai — Continuous F-1…F-7 Demo Run (F5)",
    "",
    "| Field | Value |",
    "|---|---|",
    `| Date | ${date} |`,
    "| Scope | milestones.md F5 DoD: the demo-script.md 90 s beat sheet executed on a fresh stack (video recording itself = human step, flagged not faked) |",
    "| Harness | `apps/rebook-ai/scripts/capture-demo-f5.mjs` on a fresh stack (`down -v` → `up -d --wait`) |",
    "| Cast | Nadia Cho NXQ4ZK (NX 288 SIN→AMS cancelled), Amir Hassan (agent), Grace Tan (supervisor) — demo-script.md |",
    "| F4-handoff beat | passenger SELF-SERVES the same-carrier option → containment > 0% |",
    "",
    "## Beat log (wall clock from run start)",
    "",
    ...entries.map((entry, i) => `${i + 1}. ${entry}`),
    "",
    "## Screenshots (assets/)",
    "",
    ...shotList.map((shot) => `- ![${shot.label}](assets/${shot.name}) — ${shot.label}`),
    "",
    "## Honesty notes (data-ethics.md)",
    "",
    "- Every number here was read from the running stack; no metric is invented.",
    "- The LLM beat runs on the deterministic mock provider; the badge says so.",
    "- The compensation beat is the manual supervisor compensate (audited); the",
    "  deterministic injected failure (`simulateFailure`) stays orchestrator-internal",
    "  and is covered by the saga integration suite.",
    "",
  ].join("\n");
}
