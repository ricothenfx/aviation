import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * F3 DoD e2e (milestones.md §F3): seed → inject disruption → alert → replan →
 * approve → board reflects the new schedule. Scenario control flows through the
 * production REST API; the human-in-the-loop steps (drawer, proposal, approval)
 * run through the real UI against the compose stack.
 */

const SUPERVISOR = { email: "priya.nair@nx-sim.example", password: "supervisor-nx-01" };

interface BoardFlight {
  id: string;
  flightNo: string;
  delayedMin: number;
  status: string;
  tasks: Array<{ id: string; type: string; state: string; plannedEnd: string }>;
}

/** Board snapshot; transient dev-server hiccups (compile/ECONNRESET) → null. */
async function board(request: APIRequestContext): Promise<BoardFlight[] | null> {
  try {
    const res = await request.get("/api/v1/board");
    if (!res.ok()) return null;
    return ((await res.json()) as { flights: BoardFlight[] }).flights;
  } catch {
    return null;
  }
}

/** POST with retries — the dev server compiles each route on first hit. */
async function postWithRetry(
  request: APIRequestContext,
  path: string,
  data?: unknown,
): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await request.post(path, { data });
      if (res.ok()) return true;
    } catch {
      // transient — retry
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

async function pollFor<T>(step: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await step();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("poll timed out");
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

test("seed → inject loader breakdown → alert → replan → approve → board reflects plan", async ({
  page,
  context,
}) => {
  // page.request shares the browser session cookie — scenario control needs it.
  const request: APIRequestContext = page.request;

  // 1. Seed a supervisor session (API login + cookie into the browser context),
  //    then open the real command board UI.
  const login = await page.request.post("/api/v1/auth/login", { data: SUPERVISOR });
  expect(login.ok()).toBeTruthy();
  const setCookie = login.headersArray().find((h) => h.name.toLowerCase() === "set-cookie");
  expect(setCookie).toBeDefined();
  const cookieValue = (setCookie?.value as string).split(";")[0];
  const [name, value] = cookieValue.split("=");
  await context.addCookies([{ name, value, domain: "localhost", path: "/" }]);
  await page.goto("/board");
  await expect(page.getByRole("heading", { name: "Turnaround Command Board" })).toBeVisible({
    timeout: 60_000,
  });

  // Clean slate, then run the reference day at 20× so turns start promptly.
  expect(await postWithRetry(request, "/api/v1/scenarios/reference-day/reset")).toBeTruthy();
  expect(
    await postWithRetry(request, "/api/v1/scenarios/reference-day/start", { speed: 20 }),
  ).toBeTruthy();

  // 2. Wait for a live turn, then inject the loader-breakdown script — through
  //    the scenario console UI (F4; PRD F-5 demonstrable in the same run).
  await pollFor(async () => {
    const flights = await board(request);
    return flights?.some((flight) =>
      flight.tasks.some((task) => task.type === "baggage_load" && task.state === "in_progress"),
    )
      ? true
      : null;
  }, 480_000);

  // F-6 KPI strip + F-5 scenario console are visible for the supervisor.
  await expect(page.getByRole("region", { name: "Operations KPIs" })).toBeVisible();
  const scenarioConsole = page.getByLabel("Scenario control");
  await expect(scenarioConsole).toBeVisible();
  await scenarioConsole.getByRole("button", { name: "Baggage loader breakdown" }).click();
  await expect(scenarioConsole.getByText(/Injected loader-breakdown/)).toBeVisible({
    timeout: 30_000,
  });

  // The injected turn is the one with a blocked load task.
  const flight = await pollFor(async () => {
    const flights = await board(request);
    return (
      flights?.find((candidate) =>
        candidate.tasks.some((task) => task.type === "baggage_load" && task.state === "blocked"),
      ) ?? null
    );
  }, 60_000);
  const flightNo = flight.flightNo;
  const pushbackBefore = flight.tasks.find((task) => task.type === "pushback")?.plannedEnd;

  // 3. The alert rail comes alive from the risk engine's alert.raised events.
  const alertCard = page
    .locator('[aria-live="polite"] li')
    .filter({ hasText: "leads breach by" })
    .first();
  await expect(alertCard).toBeVisible({ timeout: 60_000 });
  const leadText = await alertCard.innerText();
  const leadMinutes = Number(/leads breach by (\d+) min/.exec(leadText)?.[1] ?? "0");
  expect(leadMinutes).toBeGreaterThanOrEqual(10);

  // 4. Open the flight drawer and propose a plan (constraint engine).
  const ganttItem = page.locator(".vis-item").filter({ hasText: flightNo }).first();
  await expect(ganttItem).toBeVisible();
  await ganttItem.click();
  const drawer = page.getByRole("dialog", { name: `Flight ${flightNo} details` });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Propose plan" }).click();

  const proposal = drawer.getByLabel("Replan");
  await expect(proposal.getByText("proposed", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(proposal.getByText(/\d+ min delay/)).toBeVisible();
  await expect(proposal.getByText(/vs \d+ unmanaged/)).toBeVisible();

  // 4b. F4 DoD: every proposal carries the copilot explanation, labeled by
  // source (llm via the gateway — mock in this stack — or rules fallback).
  const explanation = proposal.getByLabel("Copilot explanation");
  await expect(explanation).toBeVisible({ timeout: 30_000 });
  await expect(explanation.getByText(/^(copilot · \S+|rules engine)$/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    explanation.getByText(/Constraint scheduler rationale|constraint|mock/i).first(),
  ).toBeVisible();

  // 5. Human approves — the plan applies; the board shifts to the new schedule.
  await proposal.getByRole("button", { name: "Approve" }).click();
  await expect(proposal.getByText("approved", { exact: true })).toBeVisible({ timeout: 30_000 });

  await pollFor(async () => {
    const flights = await board(request);
    const after = flights?.find((candidate) => candidate.flightNo === flightNo);
    const pushbackAfter = after?.tasks.find((task) => task.type === "pushback")?.plannedEnd;
    return pushbackAfter && pushbackAfter !== pushbackBefore ? pushbackAfter : null;
  }, 120_000);

  // The Gantt bar carries the moved window (board reflects the new schedule).
  await expect(page.locator(".vis-item").filter({ hasText: flightNo }).first()).toBeVisible();

  // Audit trail closes the loop: refresh the history until the replan events
  // land (the engine applies the plan asynchronously after the approval event).
  await expect(async () => {
    await drawer.getByRole("button", { name: "Refresh" }).click();
    await expect(drawer.locator("li").filter({ hasText: "replan.approved" }).first()).toBeVisible();
    await expect(
      drawer.locator("li").filter({ hasText: "task.rescheduled" }).first(),
    ).toBeVisible();
  }).toPass({ timeout: 30_000 });
});
