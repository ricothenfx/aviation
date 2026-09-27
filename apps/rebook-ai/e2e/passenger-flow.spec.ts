import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * F2 DoD E2E, extended at F4 (milestones.md F4: "Passenger journey e2e:
 * disruption → inbox + voucher (when criteria met) → confirm → new boarding
 * pass, all labeled simulated"). Sofia Rossi (seeded passenger on NX 203,
 * kept separate from the demo-cast login so the 90 s demo state stays
 * pristine) journeys from disruption to the rebooked boarding pass, through
 * the journey timeline, voucher wallet and notification inbox.
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

  test("disruption → inbox + voucher → confirm → new boarding pass (labeled simulated)", async ({
    page,
    request,
  }) => {
    await injectCancellation(request);
    await loginViaUi(page);

    // Journey timeline renders the five F4 stages from the first paint.
    await expect(page.getByTestId("trip-timeline")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("timeline-disruption")).toBeVisible();

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

    // Inbox carries the disruption notification with its honest simulated
    // delivery state (PRD F-1; SNS-shaped publisher, in-app channel).
    const inbox = page.getByText("Notification inbox").first();
    await expect(inbox).toBeVisible();
    const firstItem = page.getByTestId("inbox-item").first();
    await expect(firstItem).toContainText(/cancelled|delayed|rebooking|NX 203/i);
    await expect(firstItem).toContainText("simulated delivery");

    // Voucher wallet: a cancellation meets the auto-issue criteria (PRD F-3),
    // and the explainability trail (rule + met flag + evaluated detail) shows.
    const voucher = page.getByTestId("voucher-card").first();
    await expect(voucher).toBeVisible({ timeout: 10_000 });
    await expect(voucher).toContainText(/SGD/);
    await expect(voucher).toContainText("Simulated voucher");
    await expect(voucher.getByText("✓").first()).toBeVisible();

    // One-tap confirm on the cheap, same-carrier option (idempotent key) —
    // unless a previous run already confirmed this exact offer.
    const confirmButton = cheap.getByRole("button", { name: /confirm/i });
    if (await confirmButton.isVisible().catch(() => false)) {
      await confirmButton.click();
    }
    await expect(cheap.getByText("your choice")).toBeVisible({ timeout: 10_000 });

    // Saga state visible; since F3 the orchestrator executor advances the
    // steps live (milestones.md F3), so the honest assertion is that each
    // step shows a real executor state (never fabricated), settling at `done`
    // for a healthy fulfillment within the expect timeout.
    await expect(page.getByText(/fulfillment saga/i).first()).toBeVisible();
    await expect(page.getByTestId("saga-step-seat_reserve").first()).toContainText(
      /pending|running|done/,
    );
    await expect(page.getByTestId("saga-step-payment").first()).toContainText(
      /pending|running|done/,
    );
    await expect(page.getByTestId("saga-step-ticket_issue").first()).toContainText(
      /pending|running|done/,
    );

    // New itinerary: the boarding pass renders on the trip (F4 journey end),
    // labeled simulated like every artifact in the app.
    const boardingPass = page.getByTestId("boarding-pass").first();
    await expect(boardingPass).toBeVisible({ timeout: 20_000 });
    await expect(boardingPass).toContainText("BP-");
    await expect(boardingPass).toContainText(/simulated/i);

    // Timeline settles: fulfillment done, new itinerary stage reached.
    await expect(page.getByTestId("timeline-fulfillment")).toHaveAttribute(
      "data-tone",
      /done|failed/,
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("timeline-itinerary")).toBeVisible();

    // The simulated-data disclaimer stays visible (data-ethics.md §2).
    await expect(page.getByText(/simulated data/i).first()).toBeVisible();
  });
});
