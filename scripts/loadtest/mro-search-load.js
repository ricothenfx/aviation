/**
 * mro-copilot search load scenario (milestones.md §F5 DoD): 100 concurrent
 * viewers hammer GET /api/v1/search (hybrid retrieval, ADR-0010) with a
 * realistic mix of verbatim and paraphrased maintenance queries. Gate:
 * search p95 < 300 ms. Run by scripts/loadtest/run-mro-loadtest.mjs, which
 * also runs an independent single-client latency probe (the tiq F5 lesson:
 * generator self-starvation can inflate k6's in-process p95 — both numbers
 * are reported, the gate must hold on BOTH).
 */
import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution";

const MRO_BASE_URL = __ENV.MRO_BASE_URL || "http://localhost:3003";
const VUS = Number(__ENV.SEARCH_VUS || 100);
const DURATION = __ENV.DURATION || "120s";
/** Think time between searches per VU. 0 = closed-loop saturation (throughput
 * probe); a paced offer (e.g. 4000 ms ≈ 25 req/s demand at 100 VU) models
 * concurrent users and makes the gate a per-request latency claim. The offer
 * is recorded in verdict.json — never mixed between runs (load-report-f5.md). */
const THINK_MS = Number(__ENV.SEARCH_THINK_MS || 0);
const AUTH_COOKIE_NAME = __ENV.MRO_AUTH_COOKIE_NAME || "mro_session";
const VIEWER_EMAIL = __ENV.VIEWER_EMAIL || "tom.ng@mro-sim.example";
const VIEWER_PASSWORD = __ENV.VIEWER_PASSWORD || "viewer-nx-01";

// Golden-QA-style mix: verbatim task phrasing AND engineer paraphrases —
// hybrid retrieval must absorb both (PRD F-2, US-2).
const QUERIES = [
  "hydraulic accumulator torque",
  "no airflow after engine start",
  "accumulator precharge procedure",
  "bleed pressure low fault isolation",
  "fuel pump replacement task card",
  "which SB covers the IDG scroll seal",
  "checking hydraulic fluid level",
  "pack temperature swings",
  "landing gear actuator inspection",
  "replacing the hydraulic filter element",
  "IPC figure for the brake control valve",
  "odour in cockpit during climb",
];

export const options = {
  scenarios: {
    searchers: {
      executor: "constant-vus",
      exec: "searchLoop",
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    // First read of the gate; the independent probe is the tie-breaker/clock
    // (same discipline as the tiq F5 run, load-report-f5.md).
    "http_req_duration{scenario:searchers}": ["p(95)<300"],
  },
};

export function setup() {
  const response = http.post(
    `${MRO_BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: VIEWER_EMAIL, password: VIEWER_PASSWORD }),
    { headers: { "content-type": "application/json" } },
  );
  check(response, { "viewer login ok": (r) => r.status === 200 });
  if (response.status !== 200) {
    throw new Error(`viewer login failed with ${response.status}`);
  }
  return { token: response.json().token };
}

export function searchLoop(data) {
  // Deterministic per-VU rotation through the query mix (no thundering herd
  // on one query); rotation offset by VU id for coverage.
  const query = QUERIES[(__VU + exec.scenario.iterationInTest) % QUERIES.length];
  const response = http.get(
    `${MRO_BASE_URL}/api/v1/search?q=${encodeURIComponent(query)}&limit=5`,
    {
      cookies: { [AUTH_COOKIE_NAME]: data.token },
      tags: { name: "GET search" },
    },
  );
  check(response, {
    "search ok": (r) => r.status === 200,
    "hybrid or lexical": (r) => {
      const mode = r.json("mode");
      return mode === "hybrid" || mode === "lexical";
    },
  });
  if (THINK_MS > 0) sleep(THINK_MS / 1000);
}
