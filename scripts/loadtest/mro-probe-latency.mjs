#!/usr/bin/env node
/**
 * Independent latency probe for the mro-copilot F5 load run (milestones.md
 * §F5). One Node client, single-socket, paced: one search every 500 ms and
 * one ask every 2.5 s, measuring request→response latency for BOTH while k6
 * saturates the same stack. Rationale (tiq F5 lesson, load-report-f5.md):
 * k6's in-process latency trend can be inflated by generator self-starvation
 * on small hosts — the probe is the neutral clock; the gate is judged on
 * BOTH numbers and both are reported.
 */
import { readFileSync, writeFileSync } from "node:fs";

const MRO_BASE_URL = process.env.MRO_BASE_URL ?? "http://localhost:3003";
const OUT = process.env.MRO_PROBE_OUT ?? "/tmp/kilo/mro-probe-latency.json";
const WINDOW_MS = Number(process.env.MRO_PROBE_WINDOW_MS ?? 260000);
const AUTH_COOKIE_NAME = process.env.MRO_AUTH_COOKIE_NAME ?? "mro_session";
const EMAIL = process.env.ENGINEER_EMAIL ?? "siti.rahayu@mro-sim.example";
const PASSWORD = process.env.ENGINEER_PASSWORD ?? "engineer-nx-01";
const SEARCH_PERIOD_MS = Number(process.env.PROBE_SEARCH_PERIOD_MS ?? 500);
const ASK_PERIOD_MS = Number(process.env.PROBE_ASK_PERIOD_MS ?? 2500);

const SEARCH_QUERIES = [
  "hydraulic accumulator torque",
  "no airflow after engine start",
  "bleed pressure low fault isolation",
  "fuel pump replacement task card",
  "landing gear actuator inspection",
  "odour in cockpit during climb",
];
const ASK_QUESTIONS = [
  "What is the torque for the hydraulic accumulator attach bolts?",
  "How do I isolate a low bleed pressure fault?",
  "How do I replace the hydraulic filter element?",
  "What is the winglet paint specification for the NX-320?",
];

const login = await fetch(`${MRO_BASE_URL}/api/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (login.status !== 200) {
  console.error(`[probe] login failed with ${login.status}`);
  process.exit(1);
}
const { token: session } = await login.json();
const cookie = `${AUTH_COOKIE_NAME}=${session}`;

const searchSamples = [];
const askSamples = [];
let searchErrors = 0;
let askErrors = 0;

function pct(sorted, p) {
  return sorted.length ? sorted[Math.floor(p * (sorted.length - 1))] : null;
}

async function searchTick(i) {
  const query = SEARCH_QUERIES[i % SEARCH_QUERIES.length];
  const started = performance.now();
  const at = Date.now();
  try {
    const res = await fetch(
      `${MRO_BASE_URL}/api/v1/search?q=${encodeURIComponent(query)}&limit=5`,
      { headers: { cookie }, cache: "no-store" },
    );
    await res.arrayBuffer();
    if (res.ok) {
      searchSamples.push(performance.now() - started);
      searchTimed.push([at, performance.now() - started]);
    } else searchErrors += 1;
  } catch {
    searchErrors += 1;
  }
}

async function askTick(i) {
  const question = ASK_QUESTIONS[i % ASK_QUESTIONS.length];
  const started = performance.now();
  const at = Date.now();
  try {
    const res = await fetch(`${MRO_BASE_URL}/api/v1/ask`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ question }),
      cache: "no-store",
    });
    await res.arrayBuffer();
    if (res.ok) {
      askSamples.push(performance.now() - started);
      askTimed.push([at, performance.now() - started]);
    } else askErrors += 1;
  } catch {
    askErrors += 1;
  }
}

const startedAt = Date.now();
let i = 0;
let j = 0;
let searchNext = Date.now();
let askNext = Date.now();

async function loop() {
  while (Date.now() - startedAt < WINDOW_MS) {
    const searchDue = searchNext <= Date.now();
    const askDue = askNext <= Date.now();
    if (searchDue) {
      searchNext = Date.now() + SEARCH_PERIOD_MS;
      void searchTick(i++);
    }
    if (askDue) {
      askNext = Date.now() + ASK_PERIOD_MS;
      void askTick(j++);
    }
    if (!searchDue && !askDue) await new Promise((r) => setTimeout(r, 25));
  }
  finish();
}

// Phase attribution (honesty): probe samples spanning BOTH k6 scenarios mix
// load conditions, so per-scenario percentiles are computed from timestamps
// against the orchestrator's phase log when available.
const searchTimed = [];
const askTimed = [];

function inPhase(t, phase) {
  return t >= phase.start && t <= phase.end;
}

function phaseStats(samples, phases, name) {
  if (!phases || !phases[name]) return null;
  const scoped = samples.filter(([t]) => inPhase(t, phases[name])).map(([, v]) => v);
  scoped.sort((a, b) => a - b);
  return {
    samples: scoped.length,
    p50: pct(scoped, 0.5),
    p90: pct(scoped, 0.9),
    p95: pct(scoped, 0.95),
    p99: pct(scoped, 0.99),
  };
}

function finish() {
  let phases = null;
  try {
    phases = JSON.parse(readFileSync(process.env.MRO_PHASES_FILE ?? "", "utf8"));
  } catch {
    /* phases file absent — whole-window stats only */
  }
  searchSamples.sort((a, b) => a - b);
  askSamples.sort((a, b) => a - b);
  const result = {
    windowMs: WINDOW_MS,
    phases: {
      search: phaseStats(searchTimed, phases, "search"),
      ask: phaseStats(askTimed, phases, "ask"),
    },
    search: {
      samples: searchSamples.length,
      errors: searchErrors,
      min: pct(searchSamples, 0),
      p50: pct(searchSamples, 0.5),
      p90: pct(searchSamples, 0.9),
      p95: pct(searchSamples, 0.95),
      p99: pct(searchSamples, 0.99),
      max: searchSamples.length ? searchSamples[searchSamples.length - 1] : null,
    },
    ask: {
      samples: askSamples.length,
      errors: askErrors,
      min: pct(askSamples, 0),
      p50: pct(askSamples, 0.5),
      p90: pct(askSamples, 0.9),
      p95: pct(askSamples, 0.95),
      p99: pct(askSamples, 0.99),
      max: askSamples.length ? askSamples[askSamples.length - 1] : null,
    },
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.info("[probe]", JSON.stringify(result));
  process.exit(0);
}

loop();
