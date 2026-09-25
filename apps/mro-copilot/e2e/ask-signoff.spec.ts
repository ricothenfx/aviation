import { expect, test, type Page } from "@playwright/test";

/**
 * F3 DoD e2e (milestones.md §F3): login → ask → open citation into the manual
 * browser at the cited chunk → reviewer approves → answer appears in the
 * verified library. Also pins the refusal contract in the UI and the
 * source-honesty badges (FR-10/FR-12).
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

test.describe("mro-copilot ask → citation → sign-off → verified library", () => {
  test("full lifecycle", async ({ page }) => {
    test.setTimeout(240_000);
    await login(page, ENGINEER);

    // --- ask the copilot -----------------------------------------------------
    await page.goto("/ask");
    await page.getByLabel("Maintenance question").fill(GROUNDED_QUESTION);
    await page.getByRole("button", { name: "Ask" }).click();

    const draft = page.getByTestId("draft-card");
    await expect(draft).toBeVisible();
    // Source honesty (FR-12): mock provider ⇒ llm + provider disclosure.
    await expect(draft.getByText(/source: llm · provider mock/)).toBeVisible();
    // The answer must cite at least one resolvable chunk (FR-11 surface).
    await expect(draft.getByTestId("citation-list").locator("li").first()).toBeVisible();

    // --- open the first citation into the manual browser ---------------------
    const citationLink = draft.getByTestId("citation-list").getByRole("link", {
      name: "Open in manual browser →",
    });
    await citationLink.click();
    await expect(page).toHaveURL(/\/manuals\?.*chunk=/);
    // The chunk reader shows breadcrumb, fictional page and revision metadata.
    await expect(page.getByText(/Rev \d+/).first()).toBeVisible();

    await logout(page);

    // --- reviewer approves the draft ----------------------------------------
    await login(page, REVIEWER);
    await page.goto("/reviews");
    const item = page.getByTestId("queue-item").filter({ hasText: "outflow valve" }).first();
    await expect(item).toBeVisible();
    await item.getByTestId("approve-button").click();
    // The approved draft leaves the queue (empty state or fewer items).
    await expect(page.getByTestId("queue-item").filter({ hasText: "outflow valve" })).toHaveCount(0);

    // --- the answer appears in the verified library --------------------------
    await page.goto("/answers");
    await page.getByRole("tab", { name: "Verified library" }).click();
    const verified = page
      .getByTestId("answer-list")
      .locator("li")
      .filter({ hasText: "outflow valve" });
    await expect(verified).toHaveCount(1);
    await expect(verified.getByText("verified", { exact: false }).first()).toBeVisible();
    await expect(verified.getByText(/Signed off by/)).toBeVisible();

    // --- detail shows the audit trail ----------------------------------------
    await verified.getByRole("link", { name: "Open detail →" }).click();
    await expect(page.getByTestId("audit-event").first()).toBeVisible();
    await expect(page.getByText("answer.created")).toBeVisible();
    await expect(page.getByText("answer.approved")).toBeVisible();

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
    await page.goto("/ask");
    await page
      .getByLabel("Maintenance question")
      .fill("Re-circulation fan attach bolt torque for removal and installation");
    await page.getByRole("button", { name: "Ask" }).click();
    await expect(page.getByTestId("draft-card")).toBeVisible();
    await logout(page);

    await login(page, REVIEWER);
    await page.goto("/reviews");
    const item = page.getByTestId("queue-item").filter({ hasText: "Re-circulation fan" }).first();
    await expect(item).toBeVisible();
    await item.getByTestId("reject-toggle").click();
    // Reject without a note is blocked client- and server-side (FR-14).
    await item.getByTestId("reject-button").click();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await item
      .getByLabel(/Rejection note/)
      .fill("Cites the superseded revision — re-ask against the current one.");
    await item.getByTestId("reject-button").click();
    await expect(page.getByTestId("queue-item").filter({ hasText: "Re-circulation fan" })).toHaveCount(0);

    await page.goto("/answers");
    await page.getByRole("tab", { name: "Rejected" }).click();
    const rejected = page
      .getByTestId("answer-list")
      .locator("li")
      .filter({ hasText: "Re-circulation fan" });
    await expect(rejected).toHaveCount(1);
    await expect(rejected.getByText(/Rejected by/)).toBeVisible();
  });
});
