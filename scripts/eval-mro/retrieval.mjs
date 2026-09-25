#!/usr/bin/env node
/**
 * mro-copilot retrieval eval (PRD F-6/F-2 DoD, api-contracts.md §1 note:
 * the eval drives the PUBLIC endpoints — eval tests the product, not internals).
 *
 * - Loads the versioned golden-QA fixture (seed/eval/golden-qa.json).
 * - Runs each question through GET /api/v1/search (top 5) as a seeded user.
 * - Computes recall@5, hit-rate@5 and MRR against the expected citations.
 * - Writes JSON + Markdown reports to apps/mro-copilot/eval-reports/.
 * - Gates: recall@5 >= 0.85 (DoD F2) — exit code 1 on failure.
 *
 * Usage: pnpm eval:mro   (env: MRO_BASE_URL, MRO_EVAL_EMAIL, MRO_EVAL_PASSWORD)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const APP_ROOT = path.join(REPO_ROOT, "apps/mro-copilot");
const BASE_URL = process.env.MRO_BASE_URL ?? "http://localhost:3003";
const EMAIL = process.env.MRO_EVAL_EMAIL ?? "siti.rahayu@mro-sim.example";
const PASSWORD = process.env.MRO_EVAL_PASSWORD ?? "engineer-nx-01";
const TOP_K = 5;
const GATE_RECALL_AT_5 = 0.85;

const fixture = JSON.parse(readFileSync(path.join(APP_ROOT, "seed/eval/golden-qa.json"), "utf8"));
const refusal = JSON.parse(readFileSync(path.join(APP_ROOT, "seed/eval/refusal-set.json"), "utf8"));

function assertFixtures() {
  if (!Array.isArray(fixture.cases) || fixture.cases.length < 50) {
    throw new Error("golden-qa fixture must carry >= 50 cases (FR-19)");
  }
  if (!Array.isArray(refusal.cases) || refusal.cases.length < 20) {
    throw new Error("refusal-set fixture must carry >= 20 cases (FR-19)");
  }
  if (fixture.version !== refusal.version) {
    throw new Error("golden-qa and refusal-set fixture versions must bump together");
  }
}

async function login() {
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok)
    throw new Error(`login failed (${res.status}) — is the stack running at ${BASE_URL}?`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("login returned no session cookie");
  return setCookie.split(";")[0];
}

function citationKey(citation) {
  return `${citation.doc_type}|${citation.ata_chapter}|${citation.task_no}`;
}

async function search(cookie, query) {
  const params = new URLSearchParams({ q: query, limit: String(TOP_K) });
  const res = await fetch(`${BASE_URL}/api/v1/search?${params}`, {
    headers: { Cookie: cookie },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`search failed (${res.status}): ${body?.error?.code ?? "unknown"}`);
  }
  return res.json();
}

function scoreCase(caseItem, hits) {
  const expected = caseItem.expected_citations.map(citationKey);
  const hitKeys = hits.map((hit) => `${hit.docType}|${hit.ataChapter}|${hit.taskNo}`);
  const matched = expected.filter((key) => hitKeys.includes(key)).length;
  const firstMatchRank = expected.reduce((best, key) => {
    const rank = hitKeys.indexOf(key);
    const reciprocal = rank >= 0 ? 1 / (rank + 1) : 0;
    return Math.max(best, reciprocal);
  }, 0);
  return {
    matched,
    expected: expected.length,
    recallAt5: matched / expected.length,
    mrr: firstMatchRank,
  };
}

async function main() {
  assertFixtures();
  const cookie = await login();
  const startedAt = new Date().toISOString();
  const perCase = [];
  let recallSum = 0;
  let hitCount = 0;
  let mrrSum = 0;

  for (const caseItem of fixture.cases) {
    const response = await search(cookie, caseItem.question);
    const score = scoreCase(caseItem, response.results);
    recallSum += score.recallAt5;
    mrrSum += score.mrr;
    if (score.matched > 0) hitCount += 1;
    perCase.push({
      id: caseItem.id,
      question: caseItem.question,
      expected: caseItem.expected_citations.map(citationKey),
      recalled: score.matched,
      recallAt5: Number(score.recallAt5.toFixed(3)),
      mrr: Number(score.mrr.toFixed(3)),
      topHits: response.results.slice(0, TOP_K).map((hit) => ({
        docType: hit.docType,
        ataChapter: hit.ataChapter,
        taskNo: hit.taskNo,
        score: Number(hit.score.toFixed(4)),
      })),
      mode: response.mode,
    });
  }

  const total = fixture.cases.length;
  const metrics = {
    recallAt5: Number((recallSum / total).toFixed(4)),
    hitRateAt5: Number((hitCount / total).toFixed(4)),
    mrr: Number((mrrSum / total).toFixed(4)),
    gate: { recallAt5: GATE_RECALL_AT_5 },
    passed: recallSum / total >= GATE_RECALL_AT_5,
  };

  const report = {
    fixtureVersion: fixture.version,
    refusalFixtureVersion: refusal.version,
    refusalCases: refusal.cases.length,
    baseUrl: BASE_URL,
    topK: TOP_K,
    startedAt,
    cases: total,
    metrics,
    perCase,
  };

  const outDir = path.join(APP_ROOT, "eval-reports");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `retrieval-v${fixture.version}.json`);
  const mdPath = path.join(outDir, `retrieval-v${fixture.version}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

  const failures = perCase.filter((c) => c.recallAt5 < 1);
  const md = [
    "# mro-copilot retrieval eval — golden QA v" + fixture.version,
    "",
    `Started: ${startedAt} · corpus corpus-manifest v${fixture.version} · top-k=${TOP_K} · public endpoint /api/v1/search`,
    "",
    "| metric | value | gate |",
    "|---|---|---|",
    `| recall@5 | ${metrics.recallAt5} | >= ${GATE_RECALL_AT_5} ${metrics.passed ? "PASS" : "FAIL"} |`,
    `| hit-rate@5 | ${metrics.hitRateAt5} | informational |`,
    `| MRR | ${metrics.mrr} | informational |`,
    `| cases | ${total} | >= 50 (FR-19) |`,
    "",
    `Refusal fixture v${refusal.version} loaded (${refusal.cases.length} cases) — scored by the full eval from F3 (ask flow).`,
    "",
    failures.length
      ? `## Cases with missed citations (${failures.length})\n\n${failures
          .map((c) => `- **${c.id}** recall ${c.recallAt5} — ${c.question}`)
          .join("\n")}`
      : "All cases recalled their expected citations in the top 5.",
    "",
  ].join("\n");
  writeFileSync(mdPath, md);

  console.info(
    JSON.stringify({
      level: "info",
      module: "eval-mro",
      msg: "retrieval eval complete",
      fixtureVersion: fixture.version,
      cases: total,
      ...metrics,
      reports: [jsonPath, mdPath],
    }),
  );
  if (!metrics.passed) {
    console.error(`GATE FAILED: recall@5 ${metrics.recallAt5} < ${GATE_RECALL_AT_5}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify({ level: "error", module: "eval-mro", msg: "eval failed", err: String(err) }),
  );
  process.exit(1);
});
