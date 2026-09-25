import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

/**
 * F3 ask + guardrail integration tests (DoD, PRD FR-9..FR-12, api-contracts.md
 * §1/§4). Run against the compose stack web app (MRO_BASE_URL): the RAG loop
 * is exercised end-to-end — retrieval, guardrail pre-check, mock LLM,
 * citation post-check, persistence — with wire-level contract assertions.
 */

const BASE_URL = process.env.MRO_BASE_URL ?? "http://localhost:3003";

const ENGINEER = { email: "siti.rahayu@mro-sim.example", password: "engineer-nx-01" };
const REVIEWER = { email: "wei.lim@mro-sim.example", password: "reviewer-nx-01" };
const VIEWER = { email: "tom.ng@mro-sim.example", password: "viewer-nx-01" };

const pool = new Pool({
  connectionString:
    process.env.MRO_DATABASE_URL ?? "postgresql://turnaround:turnaround@localhost:5433/mro_copilot",
  max: 2,
});

afterAll(async () => {
  await pool.end();
});

async function login(account: { email: string; password: string }): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(account),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

async function ask(cookie: string, question: string, idempotencyKey?: string) {
  return fetch(`${BASE_URL}/api/v1/ask`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({ question }),
  });
}

describe("POST /api/v1/ask — RBAC", () => {
  it("401 unauthenticated with the standard envelope", async () => {
    const res = await ask("", "What torque applies to the accumulator attach bolts?");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(body.error.requestId).toMatch(/^req_/);
  });

  it("403 for viewer (engineer+ required)", async () => {
    const cookie = await login(VIEWER);
    const res = await ask(cookie, "What torque applies to the accumulator attach bolts?");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("400 on an over-short question", async () => {
    const cookie = await login(ENGINEER);
    const res = await ask(cookie, "abc");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("ask grounded path (mock provider)", () => {
  it("returns a cited draft with honest source labels", async () => {
    const cookie = await login(ENGINEER);
    const res = await ask(
      cookie,
      "What torque applies to the cabin pressure outflow valve attach bolts during installation?",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answerId: string;
      status: string;
      answer?: string;
      citations?: Array<{ chunkId: string; manualId: string; page: number; revision: string }>;
      refusalReason?: string;
      source: string;
      provider: string;
      groundingScore: number;
      retrieval: { mode: string; latencyMs: number };
    };
    expect(body.status).toBe("draft");
    expect(body.source).toBe("llm");
    expect(body.provider).toBe("mock");
    expect(body.answer).toBeTruthy();
    expect((body.citations ?? []).length).toBeGreaterThanOrEqual(1);
    expect(body.groundingScore).toBeGreaterThan(0);
    expect(body.retrieval.mode).toBe("hybrid");

    // FR-11 (public face): every citation resolves to a real chunk.
    for (const citation of body.citations ?? []) {
      const detail = await fetch(
        `${BASE_URL}/api/v1/manuals/${citation.manualId}/chunks/${citation.chunkId}`,
        { headers: { Cookie: cookie } },
      );
      expect(detail.status).toBe(200);
    }
  });

  it("replays an Idempotency-Key without duplicating the answer", async () => {
    const cookie = await login(ENGINEER);
    const key = `int-test-${Date.now()}`;
    const first = await ask(cookie, "How do I check the hydraulic accumulator precharge?", key);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { answerId: string };
    const replay = await ask(cookie, "How do I check the hydraulic accumulator precharge?", key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    const replayBody = (await replay.json()) as { answerId: string };
    expect(replayBody.answerId).toBe(firstBody.answerId);
  });
});

describe("refusal integrity (FR-10, api-contracts §4)", () => {
  it("off-corpus question is refused below the threshold with NO answer/citations keys", async () => {
    const cookie = await login(ENGINEER);
    const res = await ask(cookie, "What is the bleed duct torque for the HX-200 regional jet?");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("refused");
    expect(body.refusalReason).toBe("below_grounding_threshold");
    // Behavioral contract: refusal responses never contain answer or citations.
    expect("answer" in body).toBe(false);
    expect("citations" in body).toBe(false);
    // The refusal is persisted (draft lifecycle visibility) with source "none".
    const list = await fetch(`${BASE_URL}/api/v1/answers?status=refused`, {
      headers: { Cookie: cookie },
    });
    const listBody = (await list.json()) as {
      answers: Array<{ question: string; source: string; refusalReason: string | null }>;
    };
    const mine = listBody.answers.find((a) => a.question.includes("HX-200"));
    expect(mine).toBeTruthy();
    expect(mine!.source).toBe("none");
    expect(mine!.refusalReason).toBe("below_grounding_threshold");
  });
});

describe("sign-off lifecycle (FR-14)", () => {
  it("engineer cannot approve (role), reviewer self-approval is blocked (separation of duties)", async () => {
    const engineerCookie = await login(ENGINEER);
    const reviewerCookie = await login(REVIEWER);

    // Engineer authors a draft.
    const res = await ask(
      engineerCookie,
      "What is the main battery contactor attach bolt torque?",
      `lifecycle-${Date.now()}`,
    );
    const draft = (await res.json()) as { answerId: string; status: string };
    expect(draft.status).toBe("draft");

    // Engineer attempts approval — role ladder blocks first.
    const engineerApprove = await fetch(`${BASE_URL}/api/v1/answers/${draft.answerId}/approve`, {
      method: "POST",
      headers: { Cookie: engineerCookie },
    });
    expect(engineerApprove.status).toBe(403);

    // Reviewer authors their own draft, then attempts self-approval —
    // blocked even though the role would allow it.
    const selfAsk = await ask(
      reviewerCookie,
      "Which task card covers hydraulic reservoir pressurization?",
      `self-approval-${Date.now()}`,
    );
    const selfDraft = (await selfAsk.json()) as { answerId: string; status: string };
    if (selfDraft.status === "draft") {
      const selfApprove = await fetch(`${BASE_URL}/api/v1/answers/${selfDraft.answerId}/approve`, {
        method: "POST",
        headers: { Cookie: reviewerCookie },
      });
      expect(selfApprove.status).toBe(403);
      const body = (await selfApprove.json()) as { error: { code: string } };
      expect(body.error.code).toBe("SELF_APPROVAL_FORBIDDEN");
    }

    // Reviewer approves the engineer's draft.
    const approve = await fetch(`${BASE_URL}/api/v1/answers/${draft.answerId}/approve`, {
      method: "POST",
      headers: { Cookie: reviewerCookie },
    });
    expect(approve.status).toBe(200);
    const approved = (await approve.json()) as {
      status: string;
      review: { reviewerName: string } | null;
    };
    expect(approved.status).toBe("approved");
    expect(approved.review?.reviewerName).toBe("Wei Lim");

    // Double-approve is a lifecycle conflict.
    const second = await fetch(`${BASE_URL}/api/v1/answers/${draft.answerId}/approve`, {
      method: "POST",
      headers: { Cookie: reviewerCookie },
    });
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as { error: { code: string } };
    expect(secondBody.error.code).toBe("LIFECYCLE_CONFLICT");
  });

  it("reject requires a note; audit trail records created + rejected", async () => {
    const engineerCookie = await login(ENGINEER);
    const reviewerCookie = await login(REVIEWER);

    const res = await ask(
      engineerCookie,
      "What torque applies to the re-circulation fan attach bolts?",
      `reject-${Date.now()}`,
    );
    const draft = (await res.json()) as { answerId: string };

    const rejectEmpty = await fetch(`${BASE_URL}/api/v1/answers/${draft.answerId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: reviewerCookie },
      body: JSON.stringify({ note: "" }),
    });
    expect(rejectEmpty.status).toBe(400);

    const reject = await fetch(`${BASE_URL}/api/v1/answers/${draft.answerId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: reviewerCookie },
      body: JSON.stringify({ note: "Answer cites a superseded revision — not acceptable." }),
    });
    expect(reject.status).toBe(200);
    const rejected = (await reject.json()) as {
      status: string;
      review: { note: string } | null;
    };
    expect(rejected.status).toBe("rejected");
    expect(rejected.review?.note).toContain("superseded");

    const audit = await fetch(`${BASE_URL}/api/v1/answers/${draft.answerId}/audit`, {
      headers: { Cookie: reviewerCookie },
    });
    const auditBody = (await audit.json()) as {
      events: Array<{ eventType: string; sequence: number }>;
    };
    const types = auditBody.events.map((e) => e.eventType);
    expect(types).toContain("answer.created");
    expect(types).toContain("answer.rejected");
    const seqs = auditBody.events.map((e) => e.sequence);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    // Engineer (author) can also read the audit of their own answer.
    const ownerAudit = await fetch(`${BASE_URL}/api/v1/answers/${draft.answerId}/audit`, {
      headers: { Cookie: engineerCookie },
    });
    expect(ownerAudit.status).toBe(200);
  });

  it("audit_events is append-only at the database level", async () => {
    const { rows } = await pool.query(
      "select id from audit_events where event_type = 'answer.created' limit 1",
    );
    expect(rows.length).toBeGreaterThan(0);
    const id = rows[0]!.id as string;
    await expect(
      pool.query("update audit_events set payload = '{}' where id = $1", [id]),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query("delete from audit_events where id = $1", [id])).rejects.toThrow(
      /append-only/,
    );
  });
});

describe("eval run persistence (FR-21)", () => {
  it("reviewer can persist and read a run; engineer cannot", async () => {
    const engineerCookie = await login(ENGINEER);
    const reviewerCookie = await login(REVIEWER);

    const run = {
      mode: "retrieval",
      fixtureVersion: 1,
      startedAt: new Date().toISOString(),
      metrics: { recallAt5: 0.92 },
      gates: { recallAt5: 0.92, refusalAccuracy: null, citationValidity: null, groundedRate: null },
      passed: true,
      caseSummaries: { note: "integration smoke run" },
    };
    const forbidden = await fetch(`${BASE_URL}/api/v1/evals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: engineerCookie },
      body: JSON.stringify(run),
    });
    expect(forbidden.status).toBe(403);

    const persist = await fetch(`${BASE_URL}/api/v1/evals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: reviewerCookie },
      body: JSON.stringify(run),
    });
    expect(persist.status).toBe(201);
    const { runId } = (await persist.json()) as { runId: string };

    const list = await fetch(`${BASE_URL}/api/v1/evals`, { headers: { Cookie: reviewerCookie } });
    const listBody = (await list.json()) as { runs: Array<{ runId: string; passed: boolean }> };
    expect(listBody.runs.some((r) => r.runId === runId)).toBe(true);

    const detail = await fetch(`${BASE_URL}/api/v1/evals/${runId}`, {
      headers: { Cookie: reviewerCookie },
    });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { metrics: { recallAt5: number } };
    expect(detailBody.metrics.recallAt5).toBe(0.92);
  });
});
