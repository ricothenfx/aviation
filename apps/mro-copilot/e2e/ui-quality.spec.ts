import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * UI quality gates (ADR-0018/D-24): axe-core accessibility scanning (zero
 * critical/serious on the key screens) + committed visual baselines for the
 * stable screens (login, ask empty state, fleet dashboard).
 *
 * Determinism strategy: baselines capture screens without user-generated list
 * content (answers/reviews rows carry per-run timestamps → axe-only). The
 * fleet dashboard's wall-clock refresh label and any alert rows are masked.
 * Runs against the compose stack after `pnpm seed` (CI boots a fresh stack).
 */

const ENGINEER = { email: "siti.rahayu@mro-sim.example", password: "engineer-nx-01" };
const REVIEWER = { email: "wei.lim@mro-sim.example", password: "reviewer-nx-01" };

async function login(page: Page, account: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
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

test.describe("mro-copilot UI quality (ADR-0018)", () => {
  test("key screens pass axe with zero critical/serious violations", async ({ page }) => {
    test.slow();
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expectNoCriticalViolations(page);

    await login(page, ENGINEER);
    for (const [path, ready] of [
      ["/ask", () => expect(page.getByLabel("Maintenance question")).toBeVisible()],
      ["/search", () => expect(page.getByText(/search/i).first()).toBeVisible()],
      ["/engines", () => expect(page.getByTestId("fleet-table")).toBeVisible({ timeout: 30_000 })],
      ["/answers", () => expect(page.getByTestId("answer-list")).toBeVisible()],
    ] as const) {
      await page.goto(path);
      await ready();
      await expectNoCriticalViolations(page);
    }

    // The review queue renders for the reviewer role (approve/reject controls).
    // Guarantee a pending item even on a fresh stack: ask one question first —
    // proven-grounded wording (same as the reject-flow probe) so the corpus
    // answers with a citable draft instead of a refusal.
    await page.goto("/ask");
    await page
      .getByLabel("Maintenance question")
      .fill("Re-circulation fan attach bolt torque for removal and installation");
    await page.getByRole("button", { name: "Ask" }).click();
    await expect(page.getByTestId("draft-card")).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await login(page, REVIEWER);
    await page.goto("/reviews");
    await expect(page.getByTestId("queue-item").first()).toBeVisible({ timeout: 30_000 });
    await expectNoCriticalViolations(page);
  });

  test("login + ask + engines match committed visual baselines", async ({ page }) => {
    test.slow();
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page).toHaveScreenshot("login-1280x720.png", {
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
    });

    await login(page, ENGINEER);

    await page.goto("/ask");
    await expect(page.getByLabel("Maintenance question")).toBeVisible();
    await expect(page).toHaveScreenshot("ask-1280x720.png", {
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
    });

    await page.goto("/engines");
    await expect(page.getByTestId("fleet-table")).toBeVisible({ timeout: 30_000 });
    const mask: Locator[] = [];
    const refreshed = page.getByText(/live · refreshed/);
    if ((await refreshed.count()) > 0) mask.push(refreshed);
    const alertRows = page.getByTestId("alert-item");
    if ((await alertRows.count()) > 0) mask.push(alertRows);
    await expect(page).toHaveScreenshot("engines-1280x720.png", {
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
      mask,
    });
  });
});
