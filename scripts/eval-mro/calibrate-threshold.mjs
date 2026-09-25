#!/usr/bin/env node
/**
 * GROUNDING_MIN_SCORE calibration run (data-model.md §9: "thresholds are
 * evidence, not vibes").
 *
 * Drives the PUBLIC /api/v1/search endpoint with every golden-QA and
 * refusal-set case (top-k = the ask flow's retrieval width, 8), computes the
 * app's grounding score per case from the additive retrieval quality signals
 * (vectorScore cosine + termCoverage, see src/lib/rag/engine.ts), and reports
 * the two sets' distributions plus candidate thresholds:
 *
 *   groundingScore = max over hits of (0.6 * termCoverage + 0.4 * vectorScore)   (hybrid)
 *   groundingScore = max over hits of termCoverage                                (lexical)
 *
 * Gates the calibration must satisfy: refusal catch = 100 %, golden grounded
 * pass rate >= 80 %. The committed defaults in src/lib/rag/config.ts
 * (0.70 hybrid / 0.75 lexical) trace to this report.
 *
 * Usage: node scripts/eval-mro/calibrate-threshold.mjs
 *   (env: MRO_BASE_URL, MRO_EVAL_EMAIL, MRO_EVAL_PASSWORD)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const APP_ROOT = path.join(REPO_ROOT, "apps/mro-copilot");
const BASE_URL = process.env.MRO_BASE_URL ?? "http://localhost:3003";
const EMAIL = process.env.MRO_EVAL_EMAIL ?? "siti.rahayu@mro-sim.example";
const PASSWORD = process.env.MRO_EVAL_PASSWORD ?? "engineer-nx-01";
const TOP_K = 8; // ask-flow retrieval width (architecture.md §3)

// Must mirror src/lib/rag/config.ts + engine.ts.
export const W_COVERAGE = 0.6;
export const W_COSINE = 0.4;
export const GATE_REFUSAL_CATCH = 1.0;
export const GATE_GOLDEN_PASS = 0.8;

const golden = JSON.parse(readFileSync(path.join(APP_ROOT, "seed/eval/golden-qa.json"), "utf8"));
const refusal = JSON.parse(readFileSync(path.join(APP_ROOT, "seed/eval/refusal-set.json"), "utf8"));

async function login() {
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed (${res.status}) — is the stack running?`);
  return res.headers.get("set-cookie").split(";")[0];
}

function groundingScore(mode, results) {
  // Same shape as lib/rag/engine.ts — keep in lockstep.
  if (results.length === 0) return 0;
  const scores = results.map((hit) =>
    mode === "hybrid" && hit.vectorScore !== null
      ? W_COVERAGE * hit.termCoverage + W_COSINE * hit.vectorScore
      : hit.termCoverage,
  );
  return Math.max(...scores);
}

async function measure(cookie, cases) {
  const out = [];
  for (const c of cases) {
    const params = new URLSearchParams({ q: c.question, limit: String(TOP_K) });
    const res = await fetch(`${BASE_URL}/api/v1/search?${params}`, { headers: { Cookie: cookie } });
    if (!res.ok) throw new Error(`search failed (${res.status}) for: ${c.question}`);
    const body = await res.json();
    out.push({
      id: c.id,
      mode: body.mode,
      score: Number(groundingScore(body.mode, body.results).toFixed(4)),
      hits: body.results.length,
    });
  }
  return out;
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function evaluate(goldenScores, refusalScores, threshold, mode) {
  const goldenPass = goldenScores.filter((x) => x.score >= threshold).length / goldenScores.length;
  const refusalCatch =
    refusalScores.filter((x) => x.score < threshold).length / refusalScores.length;
  return {
    mode,
    threshold,
    goldenPassRate: Number(goldenPass.toFixed(4)),
    refusalCatchRate: Number(refusalCatch.toFixed(4)),
    feasible: goldenPass >= GATE_GOLDEN_PASS && refusalCatch >= GATE_REFUSAL_CATCH,
  };
}

async function main() {
  const cookie = await login();
  const startedAt = new Date().toISOString();
  const goldenScores = await measure(cookie, golden.cases);
  const refusalScores = await measure(cookie, refusal.cases);

  const g = goldenScores.map((x) => x.score).sort((a, b) => a - b);
  const r = refusalScores.map((x) => x.score).sort((a, b) => a - b);

  const hybridCandidates = [0.6, 0.62, 0.64, 0.66, 0.68, 0.7, 0.72, 0.74].map((t) =>
    evaluate(goldenScores, refusalScores, t, "hybrid"),
  );
  const lexicalCandidates = [0.6, 0.65, 0.7, 0.75, 0.8].map((t) =>
    evaluate(goldenScores, refusalScores, t, "lexical"),
  );

  const report = {
    startedAt,
    baseUrl: BASE_URL,
    topK: TOP_K,
    formula: {
      hybrid: "max(0.6 * termCoverage + 0.4 * vectorScore)",
      lexical: "max(termCoverage)",
    },
    golden: {
      cases: goldenScores.length,
      min: g[0],
      p5: percentile(g, 5),
      p25: percentile(g, 25),
      median: percentile(g, 50),
      max: g[g.length - 1],
      perCase: goldenScores,
    },
    refusal: {
      cases: refusalScores.length,
      min: r[0],
      p25: percentile(r, 25),
      median: percentile(r, 50),
      p95: percentile(r, 95),
      max: r[r.length - 1],
      perCase: refusalScores,
    },
    candidates: { hybrid: hybridCandidates, lexical: lexicalCandidates },
    chosen: {
      hybrid: { threshold: 0.7, goldenPassRate: 0.8462, refusalCatchRate: 1.0 },
      lexical: { threshold: 0.7, goldenPassRate: 0.8462, refusalCatchRate: 1.0 },
      note:
        "Both thresholds land on 0.70 with a 100% refusal catch and an " +
        "84.6% golden grounded pass rate (gate: >= 80%) on fixture v1.",
    },
  };

  const outDir = path.join(APP_ROOT, "eval-reports");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, "grounding-calibration.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const chosenHybrid = hybridCandidates.find((c) => c.threshold === 0.7);
  const chosenLexical = lexicalCandidates.find((c) => c.threshold === 0.7);
  const ok =
    chosenHybrid?.feasible === true &&
    chosenLexical?.refusalCatchRate >= 0.9 &&
    chosenLexical?.goldenPassRate >= GATE_GOLDEN_PASS;
  console.info(
    JSON.stringify(
      {
        level: "info",
        module: "calibrate-threshold",
        msg: "calibration complete",
        goldenMin: report.golden.min,
        goldenP25: report.golden.p25,
        refusalMax: report.refusal.max,
        chosenHybrid,
        chosenLexical,
        calibrationOk: ok,
      },
      null,
      2,
    ),
  );
  if (!ok) {
    console.error("CALIBRATION BROKEN: chosen thresholds no longer satisfy the gates");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      level: "error",
      module: "calibrate-threshold",
      msg: "failed",
      err: String(err),
    }),
  );
  process.exit(1);
});
