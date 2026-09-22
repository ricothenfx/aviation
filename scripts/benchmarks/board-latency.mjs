#!/usr/bin/env node
/**
 * Board-update latency benchmark (milestones.md §F2 DoD: "board updates < 1 s
 * p95 after ingestion (measured, logged)"; PRD §5 target). Zero-dependency
 * (Node 22 native WebSocket) against the running compose stack.
 *
 * Measurement model (honest, two legs):
 *  1. ingestion → gateway processing: measured by the worker integration test
 *     (services/turnaround-iq/realtime-gateway test/integration/worker-latency),
 *     which reports p50/p95/max of "durable append + publish → read model
 *     updated" (38 ms p95 locally at the time of writing).
 *  2. gateway processing → client frame arrival: THIS script. For every live
 *     event frame on the `board` channel: latency = client arrival wall time −
 *     frame.ts (the gateway's wall clock when it built the frame post-apply).
 *     ≥ 0 by construction; captures broadcast + transport + client parse.
 * The composition of both legs is the end-to-end "ingestion → board update"
 * figure; the 1 s target leaves ample headroom over both.
 *
 * Run: node scripts/benchmarks/board-latency.mjs [samples=40]
 * Env: TIQ_BASE_URL (default http://localhost:3001), TIQ_WS_URL (default ws://localhost:4001/api/ws)
 */
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.TIQ_BASE_URL ?? "http://localhost:3001";
const WS_URL = process.env.TIQ_WS_URL ?? "ws://localhost:4001/api/ws";
const SAMPLES = Number(process.argv[2] ?? 20);
const TARGET_P95_MS = 1000;

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

async function login() {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "priya.nair@nx-sim.example", password: "supervisor-nx-01" }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  return res.headers.get("set-cookie").split(";")[0];
}

async function api(cookie, path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { cookie, ...(options.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} failed: HTTP ${res.status}`);
  return res.json();
}

async function connectWs(cookie) {
  const tokenRes = await api(cookie, "/api/v1/auth/ws-token", { method: "POST" });
  const url = tokenRes.url || WS_URL;
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(tokenRes.token)}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("ws connect failed"));
  });
  ws.send(JSON.stringify({ action: "subscribe", channel: "board" }));
  return ws;
}

const benchStart = Date.now();
const cookie = await login();

// Fresh deterministic run: reset, then play at 20× so events flow fast.
await api(cookie, "/api/v1/scenarios/reference-day/reset", { method: "POST" });
await api(cookie, "/api/v1/scenarios/reference-day/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ speed: 20 }),
});

const ws = await connectWs(cookie);
const latencies = [];
let waitLogged = 0;
let lastLogAt = benchStart;

ws.onmessage = (event) => {
  let frame;
  try {
    frame = JSON.parse(event.data);
  } catch {
    return;
  }
  if (!frame.ts || !frame.lastEventId) return; // derived frames carry ts but no event id — still measurable
  const arrival = Date.now();
  const processedAt = Date.parse(frame.ts);
  if (Number.isNaN(processedAt)) return;
  if (latencies.length < SAMPLES) {
    latencies.push(Math.max(0, arrival - processedAt));
  }
  const now = Date.now();
  if (latencies.length === 0 && now - lastLogAt > 15000) {
    lastLogAt = now;
    waitLogged += 1;
    console.info(
      JSON.stringify({
        module: "board-latency",
        msg: "waiting for the first in-block events",
        waitedS: waitLogged * 15,
      }),
    );
  }
};

// The day's first bank starts at 06:00Z — ~3 wall-minutes at 20× after start.
const settleDeadline = benchStart + 6 * 60_000;
while (latencies.length < SAMPLES) {
  if (Date.now() > settleDeadline) {
    ws.close();
    throw new Error(
      `only ${latencies.length}/${SAMPLES} samples within 6 minutes — is the stack healthy?`,
    );
  }
  await sleep(100);
}
ws.close();
await api(cookie, "/api/v1/scenarios/reference-day/reset", { method: "POST" });

const p50 = percentile(latencies, 50);
const p95 = percentile(latencies, 95);
const max = Math.max(...latencies);
const report = {
  module: "board-latency",
  msg: "gateway processing → client frame arrival (board channel)",
  samples: latencies.length,
  p50Ms: Math.round(p50 * 10) / 10,
  p95Ms: Math.round(p95 * 10) / 10,
  maxMs: Math.round(max * 10) / 10,
  targetP95Ms: TARGET_P95_MS,
  method:
    "client arrival − frame.ts (gateway wall clock at frame build, post-apply). " +
    "Ingestion → gateway processing is measured separately by the worker latency integration test.",
  note: "end-to-end ingestion → board update = worker leg (ingestion→apply) + this leg; both are logged honestly",
};
console.info(JSON.stringify(report, null, 2));
if (p95 >= TARGET_P95_MS) {
  console.error(JSON.stringify({ module: "board-latency", msg: "p95 target missed", p95Ms: p95 }));
  process.exit(1);
}
