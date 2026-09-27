import { afterAll, describe, expect, it } from "vitest";
import { auditTrailViewSchema } from "@aviation/contracts";

/**
 * F4 DoD integration suite (milestones.md F4; api-contracts.md §1 additive
 * GET /api/v1/admin/audit): the supervisor audit trail answers "who decided
 * what for whom, when" (PRD F-7) — RBAC (supervisor-only), actor attribution,
 * read-side PNR locator enrichment, and newest-first ordering. Drives its own
 * disruption → confirm so the asserted rows exist on a fresh stack; on re-runs
 * the trail rows from the earlier run persist (append-only), keeping the suite
 * re-runnable (F2 confirm-suite convention).
 */

const BASE_URL = process.env.REBOOK_BASE_URL ?? "http://localhost:3004";

const PASSENGER = { email: "sofia.rossi@pax-sim.example", password: "passenger-nx-02" };
const AGENT = { email: "amir.hassan@nx-sim.example", password: "agent-nx-01" };
const SUPERVISOR = { email: "grace.tan@nx-sim.example", password: "supervisor-nx-01" };
const FLIGHT = "NX 203";

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

/** Poll the audit trail until the predicate matches (bounded, honest failure). */
async function pollAudit(
  timeoutMs: number,
  predicate: (entries: ReturnType<typeof parseTrail>) => boolean,
): Promise<ReturnType<typeof parseTrail>> {
  const started = Date.now();
  for (;;) {
    const res = await get("/api/v1/admin/audit?limit=200", "sup");
    if (res.status === 200) {
      const parsed = parseTrail(res.body);
      if (predicate(parsed)) return parsed;
    }
    if (Date.now() - started > timeoutMs)
      throw new Error(`audit trail predicate not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

function parseTrail(body: unknown) {
  const parsed = auditTrailViewSchema.safeParse(body);
  expect(parsed.success, "audit trail validates against the additive view schema").toBe(true);
  return parsed.success ? parsed.data.entries : [];
}

afterAll(async () => {
  /* stack stays up for the sibling suites */
});

describe("supervisor audit trail (api-contracts.md §1 additive F4, PRD F-7)", () => {
  it("enforces the RBAC matrix: anon 401, passenger 403, agent 403, supervisor only", async () => {
    await login("pax");
    await login("agent");
    await login("sup");

    const anon = await get("/api/v1/admin/audit");
    expect(anon.status).toBe(401);

    const pax = await get("/api/v1/admin/audit", "pax");
    expect(pax.status).toBe(403);

    const agent = await get("/api/v1/admin/audit", "agent");
    expect(agent.status).toBe(403);
  });

  it("attributes scenario injections to the acting supervisor with evaluated details", async () => {
    // Ensure at least one decision exists even on a fresh stack (idempotent).
    await post(
      "/api/v1/scenario/inject",
      "sup",
      { scenario: "cancellation", flightNo: FLIGHT },
      `it-audit-${FLIGHT}`,
    );

    const entries = await pollAudit(10_000, (all) =>
      all.some((e) => e.action === "scenario.injected" && e.targetId === FLIGHT),
    );
    const inject = entries.find((e) => e.action === "scenario.injected" && e.targetId === FLIGHT)!;
    expect(inject.actor).toBe(SUPERVISOR.email);
    expect(inject.actorRole).toBe("supervisor");
    expect((inject.details as { disruptionKind?: string } | null)?.disruptionKind).toBe(
      "cancellation",
    );
    // Newest first (append-only trail, latest decisions on top).
    const stamps = entries.map((e) => e.createdAt);
    expect([...stamps].sort().reverse()).toEqual(stamps);
  });

  it("resolves the PNR locator read-side: a passenger confirm lands with its booking", async () => {
    // Drive a real confirm as Sofia: poll her summary until the pipeline has
    // produced a full proposed offer set (fresh stack), confirm the
    // same-carrier option, and expect the trail row. On a re-run her offer is
    // already confirmed — the append-only trail keeps the earlier Sofia row,
    // so the assertion below is stable either way.
    const started = Date.now();
    let openOffer: {
      id: string;
      options: Array<{ id: string; interline: boolean }>;
    } | null = null;
    while (Date.now() - started <= 10_000) {
      const summaryRes = await get("/api/v1/pax/summary", "pax");
      expect(summaryRes.status).toBe(200);
      const summary = summaryRes.body as {
        offers: Array<{
          id: string;
          state: string;
          options: Array<{ id: string; interline: boolean }>;
        }>;
      };
      openOffer =
        summary.offers.find((offer) => offer.state === "proposed" && offer.options.length >= 3) ??
        null;
      if (openOffer) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (openOffer) {
      const option = openOffer.options.find((o) => !o.interline)!;
      const confirm = await post(
        `/api/v1/pax/offers/${openOffer.id}/confirm`,
        "pax",
        { optionId: option.id },
        `it-audit-confirm-${openOffer.id}`,
      );
      expect([200, 201, 409]).toContain(confirm.status); // 409 = already decided (re-run)
    }

    const entries = await pollAudit(10_000, (all) =>
      all.some(
        (e) =>
          e.action === "offer.confirmed" &&
          e.actorRole === "passenger" &&
          e.actor === PASSENGER.email &&
          e.locator,
      ),
    );
    const confirm = entries.find(
      (e) =>
        e.action === "offer.confirmed" &&
        e.actorRole === "passenger" &&
        e.actor === PASSENGER.email &&
        e.locator,
    )!;
    expect(confirm.locator).toMatch(/^[A-Z0-9]{6}$/);
  });
});
