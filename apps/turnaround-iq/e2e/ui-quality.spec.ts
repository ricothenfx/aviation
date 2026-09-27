import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * UI quality gates (ADR-0018/D-24): automated accessibility scanning (axe-core,
 * zero critical/serious violations on the key screens) and visual regression
 * (committed toHaveScreenshot baselines; deliberate redesigns re-baseline with
 * `playwright test --update-snapshots`).
 *
 * Determinism strategy: the board is captured in the RESET reference-day state —
 * fixed scenario window (2026-09-22 05:00Z–21:00Z, BoardShell DAY_START/DAY_END),
 * idle clock, seeded gantt bars — so the only dynamic pixels are the live-frame
 * "seconds ago" indicator, which is masked when present.
 */

const SUPERVISOR = { email: "priya.nair@nx-sim.example", password: "supervisor-nx-01" };

async function loginSupervisor(page: Page): Promise<void> {
  const login = await page.request.post("/api/v1/auth/login", { data: SUPERVISOR });
  expect(login.ok()).toBeTruthy();
  const setCookie = login.headersArray().find((h) => h.name.toLowerCase() === "set-cookie");
  expect(setCookie).toBeDefined();
  const cookieValue = (setCookie?.value as string).split(";")[0];
  const [name, value] = cookieValue.split("=");
  await page.context().addCookies([{ name, value, domain: "localhost", path: "/" }]);
}

async function resetReferenceDay(request: APIRequestContext): Promise<void> {
  const res = await request.post("/api/v1/scenarios/reference-day/reset");
  expect(res.ok()).toBeTruthy();
}

async function openResetBoard(page: Page): Promise<void> {
  await loginSupervisor(page);
  await resetReferenceDay(page.request);
  await page.goto("/board");
  await expect(page.getByRole("heading", { name: "Turnaround Command Board" })).toBeVisible({
    timeout: 60_000,
  });
  // The deterministic state: gantt bars rendered from the seeded plan, scenario
  // console resolved (not skeletons), mandatory disclaimer visible (§9).
  await expect(page.locator(".vis-item").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel("Scenario control").getByText("Scenario clock:")).toBeVisible();
  await expect(page.getByTestId("simulated-data-disclaimer")).toBeVisible();
}

/** Assert zero critical/serious axe violations; failures list every finding. */
async function expectNoCriticalViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const bad = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  const report = bad
    .map(
      (v) =>
        `${v.id} [${v.impact}] ${v.help}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    )
    .join("\n");
  expect(report, "axe critical/serious violations").toBe("");
}

test.describe("turnaround-iq UI quality (ADR-0018)", () => {
  test("login + board (reset state) + drawer pass axe with zero critical/serious", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
    await expectNoCriticalViolations(page);

    await openResetBoard(page);
    await expectNoCriticalViolations(page);

    // The drawer is the key detail surface (keyboard access pinned by the
    // visual-smoke spec) — scan the page with the dialog open.
    const chip = page.getByRole("button", { name: /Open flight .+ details/ }).first();
    await chip.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoCriticalViolations(page);
    await page.keyboard.press("Escape");
  });

  test("board + login match committed visual baselines", async ({ page }) => {
    test.slow();
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
    await expect(page).toHaveScreenshot("login-1280x720.png", {
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
    });

    await openResetBoard(page);
    // Mask wall-clock/suite-order-derived pixels: the live "seconds ago"
    // indicator (ws) and the retained scenario speed (reset keeps the last
    // start's speed, so the label depends on which suite ran before).
    const mask: Locator[] = [];
    const secondsAgo = page.getByText(/\bs\b.*\bago\b/);
    if ((await secondsAgo.count()) > 0) mask.push(secondsAgo.first());
    const speedLabel = page.getByText(/speed ×\d+/);
    if ((await speedLabel.count()) > 0) mask.push(speedLabel);
    await expect(page).toHaveScreenshot("board-1280x720.png", {
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
      mask,
    });
  });
});
