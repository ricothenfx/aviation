import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Exploratory frontend coverage (autonomous test session, user-requested):
 * gaps not pinned by board-replan/visual-smoke/ui-quality —
 *   1. real-UI login (demo chips, wrong-password error)
 *   2. unauthenticated /board → /login redirect
 *   3. RBAC gating for viewer and coordinator (API + console + replan button)
 *   4. theme toggle (ADR-0020): default dark, persist, no-flash on reload
 *   5. sign out
 *   6. supervisor scenario console controls (speed press, reset)
 */

const ACCOUNTS = {
  supervisor: { email: "priya.nair@nx-sim.example", password: "supervisor-nx-01" },
  coordinator: { email: "maya.tan@nx-sim.example", password: "coordinator-nx-01" },
  viewer: { email: "arif.rahman@nx-sim.example", password: "viewer-nx-01" },
} as const;

async function loginViaUi(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Turnaround Command Board" })).toBeVisible({
    timeout: 60_000,
  });
}

/** Cookie-session login; supervisor-only reset (403 for others = RBAC proof). */
async function loginAndReset(
  page: Page,
  account: { email: string; password: string },
): Promise<void> {
  const login = await page.request.post("/api/v1/auth/login", { data: account });
  expect(login.ok()).toBeTruthy();
  const setCookie = login.headersArray().find((h) => h.name.toLowerCase() === "set-cookie");
  const cookieValue = (setCookie?.value as string).split(";")[0];
  const [name, value] = cookieValue.split("=");
  await page.context().addCookies([{ name, value, domain: "localhost", path: "/" }]);
  const reset = await page.request.post("/api/v1/scenarios/reference-day/reset");
  if (account.email === ACCOUNTS.supervisor.email) {
    expect(reset.ok()).toBeTruthy();
  } else {
    expect(reset.status()).toBe(403);
  }
}

async function openFirstFlightDrawer(page: Page): Promise<void> {
  await expect(page.locator(".vis-item").first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /Open flight .+ details/ }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test("wrong password shows an error and stays on /login", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ACCOUNTS.viewer.email);
  await page.getByLabel("Password").fill("definitely-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 15_000 });
  expect(new URL(page.url()).pathname).toBe("/login");
});

test("unauthenticated /board redirects to /login", async ({ page }) => {
  await page.goto("/board");
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
});

test("demo account chip fills the form and real-UI login lands on the board", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: ACCOUNTS.coordinator.email }).click();
  await expect(page.getByLabel("Email")).toHaveValue(ACCOUNTS.coordinator.email);
  await expect(page.getByLabel("Password")).toHaveValue(ACCOUNTS.coordinator.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Turnaround Command Board" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Maya Tan")).toBeVisible();
  await expect(page.getByText("coordinator", { exact: true })).toBeVisible();
});

test("viewer: reset API 403, no scenario console, drawer has no replan action", async ({
  page,
}) => {
  await loginAndReset(page, ACCOUNTS.viewer);
  await page.goto("/board");
  await expect(page.locator(".vis-item").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel("Scenario control")).toHaveCount(0);
  await expect(page.getByText("Scenario console (supervisor)")).toHaveCount(0);
  await openFirstFlightDrawer(page);
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("button", { name: "Propose plan" })).toHaveCount(0);
  await expect(drawer.getByText("Ground tasks · SLA countdown")).toBeVisible();
});

test("coordinator: reset API 403, no console, drawer offers Propose plan", async ({ page }) => {
  await loginAndReset(page, ACCOUNTS.coordinator);
  await page.goto("/board");
  await expect(page.locator(".vis-item").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel("Scenario control")).toHaveCount(0);
  await openFirstFlightDrawer(page);
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("button", { name: "Propose plan" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("theme toggle: dark default, light persists across reload without flash", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("aviation-theme")))
    .toBe("light");
  await page.reload({ waitUntil: "domcontentloaded" });
  expect(
    await page.evaluate(() => document.documentElement.getAttribute("data-theme")),
  ).toBe("light");
  // Hydration signal: the React-rendered label reflects the hook state read
  // from <html>. Wait for it before clicking — a pre-hydration click would
  // land on a button with no handler attached yet.
  const toggle = page.getByTestId("theme-toggle");
  await expect(toggle).toHaveAttribute("aria-label", "Switch to dark theme", { timeout: 30_000 });
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("aviation-theme")))
    .toBe("dark");
});

test("supervisor: sign out returns to /login and the session is gone", async ({ page }) => {
  await loginViaUi(page, ACCOUNTS.supervisor);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  await page.goto("/board");
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
});

test("supervisor: console speed press sticks and reset returns the day to idle", async ({
  page,
}) => {
  await loginAndReset(page, ACCOUNTS.supervisor);
  await page.goto("/board");
  const scenarioConsole = page.getByLabel("Scenario control");
  await expect(scenarioConsole.getByText("Scenario clock:")).toBeVisible({ timeout: 30_000 });

  await scenarioConsole.getByRole("button", { name: "×5" }).click();
  await expect(scenarioConsole.getByRole("button", { name: "×5" })).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: 15_000 },
  );

  await scenarioConsole.getByRole("button", { name: "Reset" }).click();
  await expect(scenarioConsole.getByText(/idle|speed ×0/).first()).toBeVisible({ timeout: 15_000 });
  // The reset applies asynchronously through the projection pipeline
  // (coalesced rebuilds). Reset invariant: every ground task back to pending
  // (flight statuses keep the seed's built-in delays — the reference day plans
  // some flights late on purpose), and the event feed is back to its empty state.
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/v1/board");
        if (!res.ok()) return false;
        const flights = ((await res.json()) as {
          flights: Array<{ tasks: Array<{ state: string }> }>;
        }).flights;
        return flights.every((flight) => flight.tasks.every((task) => task.state === "pending"));
      },
      { timeout: 30_000, intervals: [1_000] },
    )
    .toBe(true);
  // Server truth after reset: a fresh session sees an empty feed. (Known minor
  // UX gap, left as observed: an already-open feed keeps events received before
  // the reset until reload — recorded in the test-session report.)
  await page.reload();
  await expect(page.getByText("No events yet")).toBeVisible({ timeout: 30_000 });
});
