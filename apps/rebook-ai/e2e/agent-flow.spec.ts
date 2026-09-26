import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * F3 DoD E2E (milestones.md): agent login → request proposal → inspect trace
 * → approve → saga completes → boarding pass visible. Uses the demo cast
 * (Nadia Cho, NXQ4ZK on NX 288) per demo-script.md's 30–50 s beat. The
 * recommended option is the interline partner (earliest arrival), so the
 * approval runs through the supervisor elevation gate — exactly the demo
 * script's story.
 *
 * Re-run tolerance (documented F2 convention): the full click-through needs a
 * fresh stack (`docker compose --profile rebook down -v` first); on re-runs
 * the journey asserts the completed state instead.
 */

const SUPERVISOR = { email: "grace.tan@nx-sim.example", password: "supervisor-nx-01" };
const AGENT = { email: "amir.hassan@nx-sim.example", password: "agent-nx-01" };
const PASSENGER = { email: "nadia.cho@pax-sim.example", password: "passenger-nx-01" };
const FLIGHT = "NX 288";
const LOCATOR = "NXQ4ZK";

async function injectCancellation(request: APIRequestContext): Promise<void> {
  const login = await request.post("/api/v1/auth/login", { data: SUPERVISOR });
  expect(login.ok()).toBeTruthy();
  const res = await request.post("/api/v1/scenario/inject", {
    headers: { "Idempotency-Key": `e2e-agent-flow-${Date.now()}` },
    data: { scenario: "cancellation", flightNo: FLIGHT },
  });
  expect([200, 201, 400]).toContain(res.status()); // 400 = already disrupted (re-run)
}

async function loginViaUi(page: Page, who: typeof AGENT): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(who.email);
  await page.getByLabel(/password/i).fill(who.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/(trip|console)/);
}

test.describe("agentic rebooking + saga fulfillment (F3 DoD)", () => {
  test("agent proposal → supervisor approval → boarding pass", async ({ page, request }) => {
    await injectCancellation(request);

    // 1. Agent login → console → open the disrupted booking. On a re-run the
    // booking has left the queue (served) — verify the completed state.
    await loginViaUi(page, AGENT);
    await page.goto("/console");
    // Wait for the queue panel to leave its loading state before branching.
    await page.getByTestId("queue-waiting").waitFor({ timeout: 20_000 });
    const row = page.getByTestId(`queue-row-${LOCATOR}`).first();
    if (!(await row.isVisible().catch(() => false))) {
      await loginViaUi(page, PASSENGER);
      await page.goto("/trip");
      await expect(page.getByTestId("boarding-pass")).toBeVisible();
      return;
    }
    await row.click();

    // 2. Request a proposal and inspect the tool trace + honesty badges.
    await page.getByTestId("request-proposal").click();
    const card = page.getByTestId("proposal-card").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    // Honesty badges (D-10): mock provider is the compose default.
    await expect(card.getByTestId("proposal-source")).toContainText("llm");
    await expect(card).toContainText("provider: mock");
    await expect(card).toContainText("Supervisor approval required"); // interline gate
    await card.getByTestId("proposal-trace-toggle").click();
    const trace = card.getByTestId("proposal-trace");
    await expect(trace).toBeVisible();
    await expect(trace).toContainText("search_routings");
    await expect(trace).toContainText("price_itinerary");
    await expect(trace).toContainText("check_policy");

    // 3. Supervisor elevation: agent is 403 on interline — switch accounts.
    await loginViaUi(page, SUPERVISOR);
    await page.goto("/console");
    await page.getByTestId(`queue-row-${LOCATOR}`).first().click();
    const supervisorCard = page.getByTestId("proposal-card").first();
    await expect(supervisorCard).toBeVisible({ timeout: 30_000 });
    await expect(supervisorCard).toContainText("proposed");
    await supervisorCard
      .getByTestId("proposal-note")
      .fill("Partner rebooking confirmed with passenger.");
    // The approve applies through the shared saga path; once it lands the
    // passenger is served and the queue row unmounts — wait on the network
    // response, not on this transient DOM (deterministic).
    const approveResponse = page.waitForResponse(
      (res) => res.url().includes("/approve") && res.request().method() === "POST",
      { timeout: 20_000 },
    );
    await supervisorCard.getByTestId("proposal-approve").click();
    expect((await approveResponse).status()).toBe(201);

    // 5. Boarding pass visible on the passenger trip (demo beat).
    await loginViaUi(page, PASSENGER);
    await page.goto("/trip");
    const boardingPass = page.getByTestId("boarding-pass");
    await expect(boardingPass).toBeVisible({ timeout: 30_000 });
    await expect(boardingPass).toContainText("BP-");
    await expect(page.getByTestId("saga-step-ticket_issue")).toContainText("done");
  });
});
