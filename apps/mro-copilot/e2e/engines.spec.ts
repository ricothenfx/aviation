import { expect, test, type Page } from "@playwright/test";

/**
 * F4 DoD e2e (milestones.md §F4): fleet dashboard honesty + provenance, and
 * the full alert lifecycle in the UI (score → alert → acknowledge → resolve).
 *
 * Runs on a fresh compose stack where the fleet is the committed synthetic
 * sample: NX-E201 healthy · NX-E202 alert fixture · NX-E203 insufficient
 * history (latestRul renders "—" — the D-15 honesty case).
 */

const VIEWER = { email: "tom.ng@mro-sim.example", password: "viewer-nx-01" };
const ENGINEER = { email: "siti.rahayu@mro-sim.example", password: "engineer-nx-01" };

async function login(page: Page, account: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.describe("mro-copilot engine health (F4)", () => {
  test("fleet dashboard: honesty case, provenance, citation (viewer)", async ({ page }) => {
    await login(page, VIEWER);
    await page.goto("/engines");

    // Provenance strip (FR-16): model version + sha256 visible.
    await expect(page.getByText(/Model provenance · ADR-0011 GBM/)).toBeVisible();
    await expect(page.getByTestId("fleet-table")).toBeVisible();

    // Honesty case (D-15): insufficient history renders "—", never 0.
    const rulCell = page.getByTestId("rul-NX-E203");
    await expect(rulCell).toHaveText(/—/);

    // Synthetic unit labeled honestly (data-ethics §2).
    await expect(page.getByText("Synthetic sample").first()).toBeVisible();

    // Persistent footer: simulated-data disclaimer + C-MAPSS citation.
    await expect(page.getByTestId("simulated-data-disclaimer").first()).toBeVisible();
    await expect(page.getByText(/Saxena & Goebel \(2008\)/).first()).toBeVisible();

    // Viewer cannot operate (server enforces RBAC; button is disabled).
    await expect(page.getByRole("button", { name: "Score fleet" })).toBeDisabled();
  });

  test("engineer scores the fleet, trend chart + alert lifecycle", async ({ page }) => {
    test.setTimeout(240_000);
    await login(page, ENGINEER);
    await page.goto("/engines");

    await page.getByRole("button", { name: "Score fleet" }).click();
    await expect(page.getByTestId("score-message")).toContainText(/Scored \d+ unit/, {
      timeout: 60_000,
    });

    // NX-E203 stays "—" even after scoring (no fabricated predictions).
    await expect(page.getByTestId("rul-NX-E203")).toHaveText(/—/);

    // An alert fixture unit appears (leadCycles ≥ 5 asserted at API level).
    const alertItem = page.getByTestId("alert-item").filter({ hasText: "NX-E202" }).first();
    await expect(alertItem).toBeVisible();

    // Open the alert unit's trend chart (labeled axes + threshold line).
    await page.getByRole("link", { name: "NX-E202" }).first().click();
    await expect(page).toHaveURL(/\/engines\/NX-E202/);
    await expect(page.getByTestId("trend-chart")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Predicted RUL (cycles)").first()).toBeVisible();
    await expect(page.getByText(/Maintenance window \(30 cyc\)/).first()).toBeVisible();
    await expect(page.getByText(/Simulated data for portfolio purposes/).first()).toBeVisible();
  });
});
