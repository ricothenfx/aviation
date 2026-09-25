#!/usr/bin/env node
/**
 * mro-copilot search latency benchmark (DoD F2 / PRD FR-8).
 *
 * Fires sequential end-to-end searches at the running compose stack (web app
 * → ai-service → PostgreSQL hybrid retrieval) over the golden-QA question
 * set, repeated to the target sample count, and reports p50/p95/p99/max.
 * Gate: p95 < 300 ms at reference scale — exit code 1 on failure.
 *
 * Usage: node scripts/benchmarks/mro-search-latency.mjs
 *   (env: MRO_BASE_URL, MRO_EVAL_EMAIL, MRO_EVAL_PASSWORD, SAMPLES)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const APP_ROOT = path.join(REPO_ROOT, "apps/mro-copilot");
const BASE_URL = process.env.MRO_BASE_URL ?? "http://localhost:3003";
const EMAIL = process.env.MRO_EVAL_EMAIL ?? "siti.rahayu@mro-sim.example";
const PASSWORD = process.env.MRO_EVAL_PASSWORD ?? "engineer-nx-01";
const SAMPLES = Number.parseInt(process.env.SAMPLES ?? "200", 10);
const GATE_P95_MS = 300;

const fixture = JSON.parse(readFileSync(path.join(APP_ROOT, "seed/eval/golden-qa.json"), "utf8"));
const queries = fixture.cases.map((c) => c.question);

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function login() {
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed (${res.status}) — is the stack running?`);
  return res.headers.get("set-cookie").split(";")[0];
}

async function main() {
  const cookie = await login();
  // Warmup (not counted): next dev route compile, DB caches, ai-service pool.
  for (let i = 0; i < 10; i++) {
    const params = new URLSearchParams({ q: queries[i % queries.length], limit: "10" });
    await fetch(`${BASE_URL}/api/v1/search?${params}`, { headers: { Cookie: cookie } });
  }
  const latencies = [];
  let errors = 0;
  const startedAt = Date.now();
  for (let i = 0; i < SAMPLES; i++) {
    const query = queries[i % queries.length];
    const params = new URLSearchParams({ q: query, limit: "10" });
    const t0 = performance.now();
    try {
      const res = await fetch(`${BASE_URL}/api/v1/search?${params}`, {
        headers: { Cookie: cookie },
      });
      if (!res.ok) throw new Error(String(res.status));
      await res.arrayBuffer();
    } catch {
      errors += 1;
    }
    latencies.push(performance.now() - t0);
  }
  const totalMs = Date.now() - startedAt;
  const sorted = [...latencies].sort((a, b) => a - b);
  const report = {
    startedAt: new Date(startedAt).toISOString(),
    baseUrl: BASE_URL,
    samples: SAMPLES,
    errors,
    distinctQueries: queries.length,
    p50: Number(percentile(sorted, 50).toFixed(1)),
    p95: Number(percentile(sorted, 95).toFixed(1)),
    p99: Number(percentile(sorted, 99).toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(1)),
    totalMs,
    gateP95Ms: GATE_P95_MS,
    passed: percentile(sorted, 95) < GATE_P95_MS,
  };

  const outDir = path.join(APP_ROOT, "eval-reports");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "search-latency.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.info(
    JSON.stringify({
      level: "info",
      module: "mro-search-latency",
      msg: "benchmark complete",
      ...report,
    }),
  );
  if (!report.passed) {
    console.error(`GATE FAILED: search p95 ${report.p95} ms >= ${GATE_P95_MS} ms`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      level: "error",
      module: "mro-search-latency",
      msg: "benchmark failed",
      err: String(err),
    }),
  );
  process.exit(1);
});
