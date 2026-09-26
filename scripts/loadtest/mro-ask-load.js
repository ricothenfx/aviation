/**
 * mro-copilot ask load scenario (milestones.md §F5 DoD): 25 concurrent
 * engineers drive the full RAG loop (POST /api/v1/ask — retrieval → prompt
 * assembly → mock LLM → guardrails → persistence, architecture.md §3).
 * Gate: ask p95 < 2.5 s with the mock provider. Questions rotate through a
 * grounded mix plus one off-corpus probe (refusals are a valid outcome —
 * FR-10 — and MUST stay within the latency budget too).
 */
import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution";

const MRO_BASE_URL = __ENV.MRO_BASE_URL || "http://localhost:3003";
const VUS = Number(__ENV.ASK_VUS || 25);
const DURATION = __ENV.DURATION || "120s";
/** Think time between asks per VU (see mro-search-load.js offer note). */
const THINK_MS = Number(__ENV.ASK_THINK_MS || 0);
const AUTH_COOKIE_NAME = __ENV.MRO_AUTH_COOKIE_NAME || "mro_session";
const ENGINEER_EMAIL = __ENV.ENGINEER_EMAIL || "siti.rahayu@mro-sim.example";
const ENGINEER_PASSWORD = __ENV.ENGINEER_PASSWORD || "engineer-nx-01";

const QUESTIONS = [
  "What is the torque for the hydraulic accumulator attach bolts?",
  "How do I isolate a low bleed pressure fault?",
  "Which service bulletin covers the IDG scroll seal inspection?",
  "What is the precharge procedure for the main accumulator?",
  "How do I replace the hydraulic filter element?",
  "What does the TSM say about pack temperature swings?",
  "Show me the brake control valve parts breakdown.",
  "What inspection applies to the landing gear actuator?",
  // Off-corpus probe: a refusal must be fast too (FR-10, honest latency).
  "What is the winglet paint specification for the NX-320?",
];

export const options = {
  scenarios: {
    askers: {
      executor: "constant-vus",
      exec: "askLoop",
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    "http_req_duration{scenario:askers}": ["p(95)<2500"],
  },
};

export function setup() {
  const response = http.post(
    `${MRO_BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: ENGINEER_EMAIL, password: ENGINEER_PASSWORD }),
    { headers: { "content-type": "application/json" } },
  );
  check(response, { "engineer login ok": (r) => r.status === 200 });
  if (response.status !== 200) {
    throw new Error(`engineer login failed with ${response.status}`);
  }
  return { token: response.json().token };
}

export function askLoop(data) {
  const question = QUESTIONS[(__VU + exec.scenario.iterationInTest) % QUESTIONS.length];
  const response = http.post(`${MRO_BASE_URL}/api/v1/ask`, JSON.stringify({ question }), {
    cookies: { [AUTH_COOKIE_NAME]: data.token },
    headers: { "Content-Type": "application/json" },
    tags: { name: "POST ask" },
  });
  check(response, {
    "ask ok (draft or refused)": (r) => r.status === 200,
    "honest status": (r) => {
      const status = r.json("status");
      return status === "draft" || status === "refused";
    },
  });
  if (THINK_MS > 0) sleep(THINK_MS / 1000);
}
