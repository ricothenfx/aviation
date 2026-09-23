import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * F4 DoD (milestones.md §F4, ui-design-system.md §8.6 + §9): visual smoke of
 * the command board and flight drawer at 1280×720 (interviewer projector) AND
 * tablet width (768×1024). Screenshots land in test-results/visual-smoke/ as
 * review evidence; the run also proves keyboard-only access to the drawer and
 * the mandatory footer disclaimer (data-ethics.md §2).
 */

const SUPERVISOR = { email: "priya.nair@nx-sim.example", password: "supervisor-nx-01" };

const SHOT_DIR = "test-results/visual-smoke";

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
      // transient — the dev server compiles routes on first hit
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

async function liveDay(request: APIRequestContext): Promise<void> {
  expect(await postWithRetry(request, "/api/v1/scenarios/reference-day/reset")).toBeTruthy();
  expect(
    await postWithRetry(request, "/api/v1/scenarios/reference-day/start", { speed: 20 }),
  ).toBeTruthy();
  await pollFor(async () => {
    try {
      const res = await request.get("/api/v1/board");
      if (!res.ok()) return null;
      const flights = (await res.json()) as { flights: Array<{ status: string }> };
      return flights.flights.some((flight) => flight.status !== "scheduled") ? true : null;
    } catch {
      return null;
    }
  }, 480_000);
}

async function loginSupervisor(page: Page): Promise<void> {
  const login = await page.request.post("/api/v1/auth/login", { data: SUPERVISOR });
  expect(login.ok()).toBeTruthy();
  const setCookie = login.headersArray().find((h) => h.name.toLowerCase() === "set-cookie");
  expect(setCookie).toBeDefined();
  const cookieValue = (setCookie?.value as string).split(";")[0];
  const [name, value] = cookieValue.split("=");
  await page.context().addCookies([{ name, value, domain: "localhost", path: "/" }]);
}

test("board + drawer visual smoke at 1280×720 and tablet width", async ({ page }) => {
  test.slow();
  await loginSupervisor(page);
  await liveDay(page.request);

  // ---------- 1280×720 (projector) ----------
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/board");
  await expect(page.getByRole("heading", { name: "Turnaround Command Board" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("region", { name: "Operations KPIs" })).toBeVisible();
  // Data must be ON SCREEN, not skeletons: Gantt bars + scenario clock rendered.
  const ganttItem = page.locator(".vis-item").first();
  await expect(ganttItem).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel("Scenario control").getByText("Scenario clock:")).toBeVisible({
    timeout: 60_000,
  });
  // Mandatory footer disclaimer on every screen (§9, data-ethics.md §2).
  await expect(page.getByTestId("simulated-data-disclaimer")).toBeVisible();
  await page.screenshot({ path: `${SHOT_DIR}/board-1280x720.png` });

  // Keyboard-only drawer access (§9): focus a flight chip, Enter opens.
  const chip = page.getByRole("button", { name: /Open flight .+ details/ }).first();
  await chip.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Ground tasks · SLA countdown")).toBeVisible();
  await page.screenshot({ path: `${SHOT_DIR}/drawer-1280x720.png` });
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  // ---------- tablet 768×1024 ----------
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(page.getByRole("heading", { name: "Turnaround Command Board" })).toBeVisible();
  await expect(ganttItem).toBeVisible({ timeout: 60_000 });
  // No horizontal overflow: the board degrades sensibly to tablet width (§8.6).
  await expect
    .poll(
      async () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      { timeout: 10_000 },
    )
    .toBeLessThanOrEqual(2);
  await page.screenshot({ path: `${SHOT_DIR}/board-768x1024.png` });

  await page
    .getByRole("button", { name: /Open flight .+ details/ })
    .first()
    .click();
  await expect(drawer).toBeVisible();
  await page.screenshot({ path: `${SHOT_DIR}/drawer-768x1024.png` });
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});
