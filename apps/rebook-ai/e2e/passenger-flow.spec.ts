import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * F2 DoD E2E (milestones.md): passenger login → disruption → notification →
 * confirm option → saga state visible (stub saga steps). Sofia Rossi (seeded
 * passenger on NX 203, kept separate from the demo-cast login so the 90 s
 * demo state stays pristine) journeys from disruption to confirmed rebooking.
 * Re-run tolerance: a second injection is a 400; if the newest offer was
 * already confirmed by a previous run, the journey asserts the completed state.
 */

const SUPERVISOR = { email: "grace.tan@nx-sim.example", password: "supervisor-nx-01" };
const PASSENGER = { email: "sofia.rossi@pax-sim.example", password: "passenger-nx-02" };
const FLIGHT = "NX 203"; // SIN→LHR, carries Sofia's booking

async function injectCancellation(request: APIRequestContext): Promise<void> {
  const login = await request.post("/api/v1/auth/login", { data: SUPERVISOR });
  expect(login.ok()).toBeTruthy();

  const res = await request.post("/api/v1/scenario/inject", {
    headers: { "Idempotency-Key": `e2e-cancel-${Date.now()}` },
    data: { scenario: "cancellation", flightNo: FLIGHT },
  });
  // 201 on a fresh stack; 400 when the flight is already disrupted (re-run) —
  // both proceed: Sofia's newest offers are already visible either way.
  expect([200, 201, 400]).toContain(res.status());
}

async function loginViaUi(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(PASSENGER.email);
  await page.getByLabel(/password/i).fill(PASSENGER.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/trip/);
}

test.describe("passenger disruption journey (F2 DoD)", () => {
  test("interline option shows the agent-assistance gate for passengers", async ({
    page,
    request,
  }) => {
    await injectCancellation(request);
    await loginViaUi(page);

    // The gate needs a PROPOSED offer; once the journey below confirmed the
    // newest one (re-run), the RBAC gate is covered by the integration suite.
    const confirmVisible = await page
      .getByRole("button", { name: /confirm/i })
      .first()
      .isVisible()
      .catch(() => false);
    test.skip(!confirmVisible, "no proposed offer left — journey already completed");
    const fast = page.getByTestId("option-fast").first();
    await expect(fast).toBeVisible();
    // Partner option cannot be self-confirmed (api-contracts.md §1: FORBIDDEN).
    await expect(fast.getByRole("button", { name: /agent help/i })).toBeDisabled();
  });

  test("disruption → notification → confirm → saga visible", async ({ page, request }) => {
    await injectCancellation(request);
    await loginViaUi(page);

    // Proactive notification + offers visible within seconds (PRD §5 gate).
    const disruptionBanner = page.getByText(FLIGHT, { exact: false }).first();
    await expect(disruptionBanner).toBeVisible({ timeout: 10_000 });
    const fast = page.getByTestId("option-fast").first();
    await expect(fast).toBeVisible({ timeout: 10_000 });
    const cheap = page.getByTestId("option-cheap").first();
    const flexible = page.getByTestId("option-flexible").first();
    await expect(cheap).toBeVisible();
    await expect(flexible).toBeVisible();

    // Per-rank reasons are rendered (PRD F-2).
    await expect(fast).toContainText(/earliest arrival/i);

    // One-tap confirm on the cheap, same-carrier option (idempotent key) —
    // unless a previous run already confirmed this exact offer.
    const confirmButton = cheap.getByRole("button", { name: /confirm/i });
    if (await confirmButton.isVisible().catch(() => false)) {
      await confirmButton.click();
    }
    await expect(cheap.getByText("your choice")).toBeVisible({ timeout: 10_000 });

    // Saga state visible with its stub steps (F2 boundary — executor lands F3).
    await expect(page.getByText(/fulfillment saga/i).first()).toBeVisible();
    await expect(page.getByTestId("saga-step-seat_reserve").first()).toContainText("pending");
    await expect(page.getByTestId("saga-step-payment").first()).toContainText("pending");
    await expect(page.getByTestId("saga-step-ticket_issue").first()).toContainText("pending");

    // The simulated-data disclaimer stays visible (data-ethics.md §2).
    await expect(page.getByText(/simulated data/i).first()).toBeVisible();
  });
});
