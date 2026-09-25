import { expect, test, type Page } from "@playwright/test";

/**
 * F3 DoD e2e (milestones.md §F3): login → ask → open citation into the manual
 * browser at the cited chunk → reviewer approves → answer appears in the
 * verified library. Also pins the refusal contract in the UI and the
 * source-honesty badges (FR-10/FR-12).
 *
 * The suite tolerates pre-existing answers with the same question text
 * (evals/benches create them): lifecycle assertions are count-deltas, not
 * absolute counts. CI runs against a fresh compose stack.
 *
 * Seeded demo accounts (portfolio simulation, D-09 pattern).
 */
const ENGINEER = { email: "siti.rahayu@mro-sim.example", password: "engineer-nx-01" };
const REVIEWER = { email: "wei.lim@mro-sim.example", password: "reviewer-nx-01" };

const GROUNDED_QUESTION =
  "What torque applies to the cabin pressure outflow valve attach bolts during installation?";

async function login(page: Page, account: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function logout(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

async function askAndWaitForDraft(page: Page, question: string) {
  await page.goto("/ask");
  await page.getByLabel("Maintenance question").fill(question);
  await page.getByRole("button", { name: "Ask" }).click();
  const draft = page.getByTestId("draft-card");
  await expect(draft).toBeVisible();
  return draft;
}

test.describe("mro-copilot ask → citation → sign-off → verified library", () => {
  test("full lifecycle", async ({ page }) => {
    test.setTimeout(240_000);
    await login(page, ENGINEER);

    // --- ask the copilot -----------------------------------------------------
    const draft = await askAndWaitForDraft(page, GROUNDED_QUESTION);
    // Source honesty (FR-12): mock provider ⇒ llm + provider disclosure.
    await expect(draft.getByText(/source: llm · provider mock/)).toBeVisible();
    // The answer must cite at least one resolvable chunk (FR-11 surface).
    await expect(draft.getByTestId("citation-list").locator("li").first()).toBeVisible();

    // --- open the first citation into the manual browser ---------------------
    await draft
      .getByTestId("citation-list")
      .getByRole("link", { name: "Open in manual browser →" })
      .first()
      .click();
    await expect(page).toHaveURL(/\/manuals\?.*chunk=/);
    // The chunk reader shows breadcrumb, fictional page and revision metadata.
    await expect(page.getByText(/Rev \d+/).first()).toBeVisible();

    await logout(page);

    // --- reviewer approves the newest draft ----------------------------------
    await login(page, REVIEWER);
    await page.goto("/reviews");
    const matching = page.getByTestId("queue-item").filter({ hasText: "outflow valve" });
    // The queue is newest-first: the draft this test just asked is on top.
    await expect(page.getByTestId("queue-item").first()).toContainText("outflow valve");
    const before = await matching.count();
    expect(before).toBeGreaterThanOrEqual(1);
    await page.getByTestId("queue-item").first().getByTestId("approve-button").click();
    await expect.poll(async () => matching.count(), { timeout: 20_000 }).toBe(before - 1);

    // --- the answer appears in the verified library --------------------------
    await page.goto("/answers");
    await page.getByRole("tab", { name: "Verified library" }).click();
    const verified = page
      .getByTestId("answer-list")
      .locator("li")
      .filter({ hasText: "outflow valve" });
    await expect(verified.first()).toBeVisible();
    await expect(verified.first().getByText("verified")).toBeVisible();
    await expect(verified.first().getByText(/Signed off by/)).toBeVisible();

    // --- detail shows the audit trail ----------------------------------------
    await verified.first().getByRole("link", { name: "Open detail →" }).click();
    await expect(page.getByTestId("audit-event").first()).toBeVisible();
    await expect(page.getByText("answer.created").first()).toBeVisible();
    await expect(page.getByText("answer.approved").first()).toBeVisible();

    await logout(page);
  });

  test("refusal is rendered honestly with a machine-readable reason (FR-10)", async ({ page }) => {
    await login(page, ENGINEER);
    await page.goto("/ask");
    await page
      .getByLabel("Maintenance question")
      .fill("What is the bleed duct torque for the HX-200 regional jet?");
    await page.getByRole("button", { name: "Ask" }).click();

    const refusal = page.getByTestId("refusal-card");
    await expect(refusal).toBeVisible();
    await expect(refusal.getByText("refused")).toBeVisible();
    await expect(refusal.getByText("below_grounding_threshold")).toBeVisible();
    // Refusal integrity (api-contracts §4): no answer, no citations rendered.
    expect(await refusal.getByRole("link", { name: /manual browser/ }).count()).toBe(0);
  });

  test("reject flow records the mandatory note (FR-14)", async ({ page }) => {
    test.setTimeout(240_000);
    await login(page, ENGINEER);
    const question = "Re-circulation fan attach bolt torque for removal and installation";
    await askAndWaitForDraft(page, question);
    await logout(page);

    await login(page, REVIEWER);
    await page.goto("/reviews");
    const matching = page.getByTestId("queue-item").filter({ hasText: "Re-circulation fan" });
    const item = page.getByTestId("queue-item").first();
    await expect(item).toContainText("Re-circulation fan");
    const before = await matching.count();
    expect(before).toBeGreaterThanOrEqual(1);
    await item.getByTestId("reject-toggle").click();
    // Reject without a note is blocked client- and server-side (FR-14).
    await item.getByTestId("reject-button").click();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await item
      .getByLabel(/Rejection note/)
      .fill("Cites the superseded revision — re-ask against the current one.");
    await item.getByTestId("reject-button").click();
    await expect.poll(async () => matching.count(), { timeout: 20_000 }).toBe(before - 1);

    await page.goto("/answers");
    await page.getByRole("tab", { name: "Rejected" }).click();
    const rejected = page
      .getByTestId("answer-list")
      .locator("li")
      .filter({ hasText: "Re-circulation fan" });
    await expect(rejected.first()).toBeVisible();
    await expect(rejected.first().getByText(/Rejected by/)).toBeVisible();
  });
});
