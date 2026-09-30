import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * UI quality gates (ADR-0018/D-24): axe-core accessibility scanning (zero
 * critical/serious on the key screens) + committed visual baselines for the
 * passenger trip, the supervisor scenario console and login.
 *
 * Determinism strategy: run the full suite in CI order (this spec runs LAST —
 * agent-flow → passenger-flow → ui-quality — so Sofia's newest offer is
 * already confirmed and the trip renders its settled end state: "your choice",
 * saga done, boarding pass below the fold). Wall-clock "Xs/min ago" labels are
 * masked. On a re-run the second injection is a tolerated 400 (same protocol
 * as passenger-flow.spec.ts).
 */

const SUPERVISOR = { email: "grace.tan@nx-sim.example", password: "supervisor-nx-01" };
const AGENT = { email: "amir.hassan@nx-sim.example", password: "agent-nx-01" };
const PASSENGER = { email: "sofia.rossi@pax-sim.example", password: "passenger-nx-02" };
const FLIGHT = "NX 203";

async function injectCancellation(request: APIRequestContext): Promise<void> {
  const login = await request.post("/api/v1/auth/login", { data: SUPERVISOR });
  expect(login.ok()).toBeTruthy();
  const res = await request.post("/api/v1/scenario/inject", {
    headers: { "Idempotency-Key": `ui-quality-${Date.now()}` },
    data: { scenario: "cancellation", flightNo: FLIGHT },
  });
  expect([200, 201, 400]).toContain(res.status());
}

async function loginViaUi(page: Page, who: { email: string; password: string }, url: RegExp) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(who.email);
  await page.getByLabel(/password/i).fill(who.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(url, { timeout: 20_000 });
}

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

test.describe("rebook-ai UI quality (ADR-0018)", () => {
  test("login + trip + console + supervisor pass axe with zero critical/serious", async ({
    page,
    request,
  }) => {
    test.slow();
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
    await expectNoCriticalViolations(page);

    await injectCancellation(request);
    await loginViaUi(page, PASSENGER, /\/trip/);
    await expect(page.getByTestId("trip-timeline")).toBeVisible({ timeout: 10_000 });
    await expectNoCriticalViolations(page);

    await page.getByRole("button", { name: /sign out/i }).click();
    await loginViaUi(page, AGENT, /\/console/);
    await expect(page.getByText(/NX 203/i).first()).toBeVisible({ timeout: 15_000 });
    await expectNoCriticalViolations(page);

    await page.getByRole("button", { name: /sign out/i }).click();
    await loginViaUi(page, SUPERVISOR, /\/console/);
    // Role routing lands supervisors on /console (page.tsx) — navigate to the
    // supervisor scenario console explicitly.
    await page.goto("/supervisor");
    await expectNoCriticalViolations(page);
  });

  test("login + trip + supervisor match committed visual baselines", async ({ page, request }) => {
    test.slow();
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
    await expect(page).toHaveScreenshot("login-1280x720.png", {
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
    });

    await injectCancellation(request);
    await loginViaUi(page, PASSENGER, /\/trip/);
    await expect(page.getByTestId("trip-timeline")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("option-fast").first()).toBeVisible({ timeout: 10_000 });
    const tripMask: Locator[] = [];
    const ago = page.getByText(/\b(s|min|h) ago\b|just now/);
    if ((await ago.count()) > 0) tripMask.push(ago);
    // Offer-expiry countdown (wall-clock) + per-run boarding-pass code.
    const expires = page.getByText(/expires in/);
    if ((await expires.count()) > 0) tripMask.push(expires);
    const bpCode = page.getByText(/BP-[0-9A-F]{6,}/);
    if ((await bpCode.count()) > 0) tripMask.push(bpCode);
    await expect(page).toHaveScreenshot("trip-1280x720.png", {
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
      mask: tripMask,
    });

    await page.getByRole("button", { name: /sign out/i }).click();
    await loginViaUi(page, SUPERVISOR, /\/console/);
    // Role routing lands supervisors on /console (page.tsx) — navigate to the
    // supervisor scenario console explicitly.
    await page.goto("/supervisor");
    // The audit panel hydrates client-side (5 s poll); without this wait the
    // screenshot races the fetch and "passes" on an empty panel (found the
    // race the hard way: the gate verified nothing about the trail).
    await expect(
      page
        .getByTestId("audit-row")
        .first()
        .or(page.getByText("No decisions recorded yet")),
    ).toBeVisible({ timeout: 15_000 });
    const supMask: Locator[] = [];
    const supAgo = page.getByText(/\bs ago\b/);
    if ((await supAgo.count()) > 0) supMask.push(supAgo);
    await expect(page).toHaveScreenshot("supervisor-1280x720.png", {
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
      mask: supMask,
    });
  });
});
