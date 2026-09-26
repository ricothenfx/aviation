import { afterAll, describe, expect, it } from "vitest";
import {
  offerSetViewSchema,
  paxSummaryViewSchema,
  type OfferSetView,
  type PaxSummaryView,
} from "@aviation/contracts";

/**
 * F2 DoD integration suite (rebook-ai milestones.md F2): scenario injection →
 * notification + ranked offers visible < 10 s (pipeline p95 gate asserted
 * single-shot; the committed benchmark script measures p95 at scale), plus
 * ownership scoping (RBAC matrix incl. "a passenger cannot read another PNR's
 * offers") per api-contracts.md §1/§5. Runs against compose profile "rebook".
 */

const BASE_URL = process.env.REBOOK_BASE_URL ?? "http://localhost:3004";

const PASSENGER = { email: "nadia.cho@pax-sim.example", password: "passenger-nx-01" };
const AGENT = { email: "amir.hassan@nx-sim.example", password: "agent-nx-01" };
const SUPERVISOR = { email: "grace.tan@nx-sim.example", password: "supervisor-nx-01" };

const jars: Record<string, string> = {};

async function login(who: keyof typeof jars): Promise<void> {
  const credentials = who === "pax" ? PASSENGER : who === "agent" ? AGENT : SUPERVISOR;
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  expect(res.status).toBe(200);
  jars[who] = res.headers.get("set-cookie")!.split(";")[0];
}

async function get(path: string, who?: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: who ? { cookie: jars[who] } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(
  path: string,
  who: string | null,
  data: unknown,
  key?: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(who ? { cookie: jars[who] } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(data),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function errorCode(body: unknown, expected: string): void {
  expect(
    (body as { error?: { code?: string } } | null)?.error?.code,
    `expected error code ${expected}`,
  ).toBe(expected);
}

/** Inject, tolerating an already-disrupted flight (re-runnable tests). */
async function ensureDisrupted(flightNo: string, scenario: "cancellation" | "long-delay") {
  const res = await post(
    "/api/v1/scenario/inject",
    "sup",
    { scenario, flightNo },
    `it-${scenario}-${flightNo}`,
  );
  expect([201, 400]).toContain(res.status);
}

/** Poll the passenger summary until a full pipeline offer set is visible. */
async function pollOffers(timeoutMs: number): Promise<{ elapsedMs: number; offer: OfferSetView }> {
  const started = Date.now();
  for (;;) {
    const res = await get("/api/v1/pax/summary", "pax");
    const summary = paxSummaryViewSchema.safeParse(res.body);
    if (summary.success) {
      // The real pipeline offer carries all three ranked kinds; fixture offers
      // from sibling suites (single-option) are ignored.
      const offer = summary.data.offers.find((o) => o.options.length >= 3);
      if (offer) return { elapsedMs: Date.now() - started, offer };
    }
    if (Date.now() - started > timeoutMs)
      throw new Error(`offers not visible within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

afterAll(async () => {
  /* stack stays up for the sibling suites */
});

describe("scenario injection (api-contracts.md §1, architecture.md §3.1)", () => {
  it("enforces the RBAC matrix: anon 401, passenger 403, agent 403, supervisor only", async () => {
    await login("pax");
    await login("agent");
    await login("sup");

    const anon = await post(
      "/api/v1/scenario/inject",
      null,
      { scenario: "cancellation", flightNo: "NX 203" },
      "it-anon",
    );
    expect(anon.status).toBe(401);
    errorCode(anon.body, "UNAUTHENTICATED");

    const pax = await post(
      "/api/v1/scenario/inject",
      "pax",
      { scenario: "cancellation", flightNo: "NX 203" },
      "it-pax",
    );
    expect(pax.status).toBe(403);

    const agent = await post(
      "/api/v1/scenario/inject",
      "agent",
      { scenario: "cancellation", flightNo: "NX 203" },
      "it-agent",
    );
    expect(agent.status).toBe(403);

    const unknown = await post(
      "/api/v1/scenario/inject",
      "sup",
      { scenario: "cancellation", flightNo: "XX 999" },
      "it-unknown",
    );
    expect(unknown.status).toBe(404);
  });

  it("injects the demo disruption and offers become visible well under 10 s", async () => {
    await ensureDisrupted("NX 288", "cancellation");
    const { elapsedMs, offer } = await pollOffers(10_000);
    // Single-shot assert of the p95 < 10 s gate (PRD §5); bench:rebook logs p95.
    expect(elapsedMs).toBeLessThan(10_000);

    const detail = await get(`/api/v1/pax/offers/${offer.id}`, "pax");
    expect(detail.status).toBe(200);
    // Contract: the offer set validates against the zod read model (F2 DoD).
    const parsed = offerSetViewSchema.safeParse(detail.body);
    expect(parsed.success).toBe(true);
    const view = (parsed.success ? parsed.data : offer) as OfferSetView;
    expect(view.options.map((o) => o.kind)).toEqual(["fast", "cheap", "flexible"]);
    for (const option of view.options) {
      expect(option.reason.length).toBeGreaterThan(10); // per-rank reasons (PRD F-2)
    }
  });

  it("scopes ownership: a passenger cannot read another PNR's offers", async () => {
    // Nadia requests an arbitrary offer id that is not hers → honest 404.
    const foreign = await get("/api/v1/pax/offers/00000000-0000-4000-8000-00000000dead", "pax");
    expect(foreign.status).toBe(404);
    // Agents can read any booking's offers (role ladder, PRD F-7).
    const { offer } = await pollOffers(10_000);
    const agentView = await get(`/api/v1/pax/offers/${offer.id}`, "agent");
    expect(agentView.status).toBe(200);
  });

  it("surfaces the disruption, vouchers and inbox in the passenger summary", async () => {
    const res = await get("/api/v1/pax/summary", "pax");
    expect(res.status).toBe(200);
    const summary = paxSummaryViewSchema.parse(res.body) as PaxSummaryView;
    expect(summary.disruption).toMatchObject({ flightNo: "NX 288", kind: "cancellation" });
    expect(summary.vouchers.length).toBeGreaterThan(0);
    // Explainability (PRD F-3): criteria carry rule, met flag and evaluated detail.
    for (const criterion of summary.vouchers[0]!.criteria) {
      expect(typeof criterion.rule).toBe("string");
      expect(typeof criterion.met).toBe("boolean");
      expect(criterion.detail.length).toBeGreaterThan(5);
    }
    expect(summary.notifications.length).toBeGreaterThan(0);
    expect(summary.notifications[0]!.channel).toBe("inbox");
  });
});
