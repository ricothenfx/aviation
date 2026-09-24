#!/usr/bin/env node
/**
 * Single-client latency prober (F5 diagnostics): one WebSocket consumer whose
 * only job is arrival − frame.ts, so gateway transport latency can be judged
 * independently of the 200-VU k6 client. Runs alongside the k6 scenario.
 */
import { writeFileSync } from "node:fs";

const TIQ_BASE_URL = process.env.TIQ_BASE_URL ?? "http://localhost:3001";
const WS_URL = (process.env.WS_URL ?? "ws://localhost:4001/api/ws").replace(/^http/, "ws");
const OUT = process.env.PROBE_OUT ?? "/tmp/kilo/probe-latency.json";
const WINDOW_MS = Number(process.env.PROBE_WINDOW_MS ?? 240000);

const login = await fetch(`${TIQ_BASE_URL}/api/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: process.env.VIEWER_EMAIL ?? "arif.rahman@nx-sim.example",
    password: process.env.VIEWER_PASSWORD ?? "viewer-nx-01",
  }),
});
const { token: session } = await login.json();
const mint = await fetch(`${TIQ_BASE_URL}/api/v1/auth/ws-token`, {
  method: "POST",
  headers: { cookie: `${process.env.AUTH_COOKIE_NAME ?? "tiq_session"}=${session}` },
});
const { token, url } = await mint.json();

const ws = new WebSocket(
  `${(url ?? WS_URL).replace(/^http/, "ws")}?token=${encodeURIComponent(token)}`,
);
const samples = [];
let frameCount = 0;
ws.onopen = () => ws.send(JSON.stringify({ action: "subscribe", channel: "board" }));
ws.onmessage = (event) => {
  if (typeof event.data !== "string" || !event.data.includes('"lastEventId"')) return;
  let parsed;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    return;
  }
  const frames = parsed.type === "board.batch" ? parsed.payload.frames : [parsed];
  for (const frame of frames) {
    if (!frame.lastEventId) continue;
    frameCount += 1;
    samples.push(Date.now() - Date.parse(frame.ts));
  }
};
ws.onclose = (e) => console.info(`[probe] closed ${e.code}`);
ws.onerror = (e) => console.info(`[probe] error ${e.message ?? e}`);

setTimeout(() => {
  samples.sort((a, b) => a - b);
  const at = (p) => (samples.length ? samples[Math.floor(p * (samples.length - 1))] : null);
  const result = {
    frames: frameCount,
    samples: samples.length,
    min: at(0),
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    max: samples.length ? samples[samples.length - 1] : null,
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.info("[probe]", JSON.stringify(result));
  process.exit(0);
}, WINDOW_MS);
