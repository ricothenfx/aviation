#!/usr/bin/env node
/**
 * mro-copilot FULL eval (F3 DoD, PRD FR-20/F-6): drives the PUBLIC endpoints
 * — eval tests the product, not internals.
 *
 * Gates (all must pass, exit 1 otherwise):
 *   recall@5          >= 0.85   (golden set via GET /api/v1/search)
 *   refusal accuracy  = 100%    (refusal set via POST /api/v1/ask;
 *                                status refused AND expected machine reason)
 *   citation validity = 100%    (every citation of every draft answer resolves
 *                                to a real chunk via GET /api/v1/manuals)
 *   grounded rate     >= 80%    (golden set: draft answer with >= 1 citation)
 *
 * The run is persisted via POST /api/v1/evals (reviewer service account) and
 * written as JSON + MD to apps/mro-copilot/eval-reports/.
 *
 * Usage: pnpm eval:mro:full
 *   (env: MRO_BASE_URL, MRO_EVAL_EMAIL/PASSWORD (engineer), MRO_REVIEWER_EMAIL/PASSWORD)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { citationKey, login, scoreCase, search } from "./retrieval.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const APP_ROOT = path.join(REPO_ROOT, "apps/mro-copilot");
const BASE_URL = process.env.MRO_BASE_URL ?? "http://localhost:3003";

const ENGINEER = {
  email: process.env.MRO_EVAL_EMAIL ?? "siti.rahayu@mro-sim.example",
  password: process.env.MRO_EVAL_PASSWORD ?? "engineer-nx-01",
};
const REVIEWER = {
  email: process.env.MRO_REVIEWER_EMAIL ?? "wei.lim@mro-sim.example",
  password: process.env.MRO_REVIEWER_PASSWORD ?? "reviewer-nx-01",
};

const GATE = {
  recallAt5: 0.85,
  refusalAccuracy: 1.0,
  citationValidity: 1.0,
  groundedRate: 0.8,
};

const golden = JSON.parse(readFileSync(path.join(APP_ROOT, "seed/eval/golden-qa.json"), "utf8"));
const refusal = JSON.parse(readFileSync(path.join(APP_ROOT, "seed/eval/refusal-set.json"), "utf8"));

async function ask(cookie, question, idempotencyKey) {
  const res = await fetch(`${BASE_URL}/api/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`ask failed (${res.status}): ${body?.error?.code ?? "unknown"}`);
  }
  return res.json();
}

async function chunkResolves(cookie, manualId, chunkId) {
  const res = await fetch(`${BASE_URL}/api/v1/manuals/${manualId}/chunks/${chunkId}`, {
    headers: { Cookie: cookie },
  });
  return res.ok;
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function main() {
  const startedAt = new Date().toISOString();
  const engineerCookie = await login();
  const reviewerCookie = await loginAs(REVIEWER);

  // --- retrieval gate over the golden set (same scoring as retrieval mode) ---
  const perCase = [];
  let recallSum = 0;
  for (const caseItem of golden.cases) {
    const response = await search(engineerCookie, caseItem.question);
    const score = scoreCase(caseItem, response.results);
    recallSum += score.recallAt5;
    perCase.push({ id: caseItem.id, recallAt5: Number(score.recallAt5.toFixed(3)) });
  }
  const recallAt5 = Number((recallSum / golden.cases.length).toFixed(4));

  // --- ask gates over the golden set -----------------------------------------
  const askCases = [];
  let grounded = 0;
  let citationsTotal = 0;
  let citationsValid = 0;
  const latencies = [];
  let keySeq = 0;
  for (const caseItem of golden.cases) {
    const t0 = performance.now();
    const response = await ask(engineerCookie, caseItem.question, `eval-full-${startedAt}-${keySeq++}`);
    latencies.push(performance.now() - t0);
    const citesExpected = (caseItem.expected_citations ?? []).map(citationKey);
    const citedKeys = (response.citations ?? []).map((c) => citationKey({
      doc_type: c.docType, ata_chapter: c.ataChapter, task_no: c.taskNo,
    }));
    let expectedCited = 0;
    for (const key of citesExpected) if (citedKeys.includes(key)) expectedCited += 1;

    // Citation validity: every citation must resolve to a real chunk (FR-11,
    // public-checkable face of the invariant).
    let allResolve = true;
    for (const citation of response.citations ?? []) {
      citationsTotal += 1;
      if (!(await chunkResolves(engineerCookie, citation.manualId, citation.chunkId))) {
        allResolve = false;
      } else {
        citationsValid += 1;
      }
    }
    const isGrounded =
      response.status === "draft" && (response.citations ?? []).length >= 1 && allResolve;
    if (isGrounded) grounded += 1;
    askCases.push({
      id: caseItem.id,
      status: response.status,
      source: response.source,
      provider: response.provider,
      citations: (response.citations ?? []).length,
      expectedCited,
      expectedTotal: citesExpected.length,
      citationValidity: allResolve,
      grounded: isGrounded,
    });
  }
  const groundedRate = Number((grounded / golden.cases.length).toFixed(4));
  const citationValidity = citationsTotal === 0 ? 0 : Number((citationsValid / citationsTotal).toFixed(4));

  // --- refusal gate over the refusal set -------------------------------------
  const refusalCases = [];
  let refusalHits = 0;
  for (const caseItem of refusal.cases) {
    const response = await ask(engineerCookie, caseItem.question, `eval-full-${startedAt}-${keySeq++}`);
    const ok =
      response.status === "refused" &&
      response.refusalReason === caseItem.expected_reason &&
      response.answer === undefined &&
      response.citations === undefined;
    if (ok) refusalHits += 1;
    refusalCases.push({
      id: caseItem.id,
      status: response.status,
      reason: response.refusalReason ?? null,
      expectedReason: caseItem.expected_reason,
      integrity: response.answer === undefined && response.citations === undefined,
      pass: ok,
    });
  }
  const refusalAccuracy = Number((refusalHits / refusal.cases.length).toFixed(4));

  // Also verify idempotent replay works on the wire (one sampled re-ask).
  const replayRes = await fetch(`${BASE_URL}/api/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": `eval-full-${startedAt}-0` },
    body: JSON.stringify({ question: golden.cases[0].question }),
  });
  const idempotentReplay = replayRes.headers.get("Idempotency-Replayed") === "true";

  const sorted = [...latencies].sort((a, b) => a - b);
  const metrics = {
    recallAt5,
    refusalAccuracy,
    citationValidity,
    groundedRate,
    citationsTotal,
    askLatencyMs: {
      p50: Number(percentile(sorted, 50).toFixed(1)),
      p95: Number(percentile(sorted, 95).toFixed(1)),
      max: Number(sorted[sorted.length - 1].toFixed(1)),
    },
    idempotentReplay,
  };
  const gates = {
    recallAt5: { value: recallAt5, gate: GATE.recallAt5, passed: recallAt5 >= GATE.recallAt5 },
    refusalAccuracy: {
      value: refusalAccuracy,
      gate: GATE.refusalAccuracy,
      passed: refusalAccuracy >= GATE.refusalAccuracy,
    },
    citationValidity: {
      value: citationValidity,
      gate: GATE.citationValidity,
      passed: citationValidity >= GATE.citationValidity,
    },
    groundedRate: {
      value: groundedRate,
      gate: GATE.groundedRate,
      passed: groundedRate >= GATE.groundedRate,
    },
  };
  const passed = Object.values(gates).every((g) => g.passed);

  // --- persist the run via the public eval API (FR-21) ------------------------
  let runId = null;
  const persistRes = await fetch(`${BASE_URL}/api/v1/evals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: reviewerCookie },
    body: JSON.stringify({
      mode: "full",
      fixtureVersion: golden.version,
      startedAt,
      metrics,
      gates: {
        recallAt5,
        refusalAccuracy,
        citationValidity,
        groundedRate,
      },
      passed,
      caseSummaries: { golden: askCases, refusal: refusalCases, retrieval: perCase },
      reportPath: `eval-reports/full-v${golden.version}.json`,
    }),
  });
  if (persistRes.ok) {
    runId = (await persistRes.json()).runId;
  } else {
    console.error(
      JSON.stringify({ level: "error", module: "eval-mro-full", msg: "persist failed", status: persistRes.status }),
    );
  }

  const report = {
    fixtureVersion: golden.version,
    refusalFixtureVersion: refusal.version,
    runId,
    startedAt,
    baseUrl: BASE_URL,
    metrics,
    gates,
    passed,
    perCase: { golden: askCases, refusal: refusalCases, retrieval: perCase },
  };

  const outDir = path.join(APP_ROOT, "eval-reports");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `full-v${golden.version}.json`);
  const mdPath = path.join(outDir, `full-v${golden.version}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

  const rows = [
    ["recall@5", metrics.recallAt5, ">= 0.85", gates.recallAt5.passed],
    ["refusal accuracy", metrics.refusalAccuracy, "= 100%", gates.refusalAccuracy.passed],
    ["citation validity", metrics.citationValidity, "= 100%", gates.citationValidity.passed],
    ["grounded answer rate", metrics.groundedRate, ">= 80%", gates.groundedRate.passed],
  ]
    .map(([name, value, gate, ok]) => `| ${name} | ${value} | ${gate} | ${ok ? "PASS" : "FAIL"} |`)
    .join("\n");
  const failedRefusals = refusalCases.filter((c) => !c.pass);
  const md = [
    `# mro-copilot full eval — fixtures v${golden.version} (golden 52 / refusal ${refusal.cases.length})`,
    "",
    `Started: ${startedAt} · mock provider · public endpoints (/api/v1/search, /api/v1/ask)`,
    "",
    "| gate | value | requirement | result |",
    "|---|---|---|---|",
    rows,
    "",
    `Ask latency (mock, sequential): p50 ${metrics.askLatencyMs.p50} ms · p95 ${metrics.askLatencyMs.p95} ms · max ${metrics.askLatencyMs.max} ms`,
    `Idempotent replay verified on the wire: ${idempotentReplay}`,
    runId ? `Persisted eval run: ${runId}` : "Eval run NOT persisted (persist call failed)",
    "",
    failedRefusals.length
      ? `## Refusal failures\n\n${failedRefusals.map((c) => `- **${c.id}** got ${c.status}/${c.reason}, expected ${c.expectedReason}`).join("\n")}`
      : "All refusal cases refused with the expected machine-readable reason.",
    "",
  ].join("\n");
  writeFileSync(mdPath, md);

  console.info(
    JSON.stringify({
      level: "info",
      module: "eval-mro-full",
      msg: "full eval complete",
      runId,
      ...metrics,
      passed,
    }),
  );
  if (!passed) {
    console.error(
      `GATE FAILED: ${Object.entries(gates)
        .filter(([, g]) => !g.passed)
        .map(([name, g]) => `${name} ${g.value} (gate ${g.gate})`)
        .join("; ")}`,
    );
    process.exit(1);
  }
}

async function loginAs(account) {
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(account),
  });
  if (!res.ok) throw new Error(`login failed for ${account.email} (${res.status})`);
  return res.headers.get("set-cookie").split(";")[0];
}

main().catch((err) => {
  console.error(
    JSON.stringify({ level: "error", module: "eval-mro-full", msg: "eval failed", err: String(err) }),
  );
  process.exit(1);
});
