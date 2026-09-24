/**
 * ×10 board load scenario (milestones.md §F5, ADR-0007): 200 concurrent ws
 * consumers hold the board channel open while the load producer replays 10×
 * the reference-day event log. Every 5 s each consumer samples one board frame
 * and correlates its arrival with the producer's durable-append instant
 * (GET /append-time) to measure true ingestion→board latency.
 *
 * A small REST reader layer polls GET /api/v1/board to represent console
 * refreshes against the ×10 snapshot. Run by scripts/loadtest/run-loadtest.mjs.
 */
import http from "k6/http";
import ws from "k6/ws";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const TIQ_BASE_URL = __ENV.TIQ_BASE_URL || "http://localhost:3001";
const WS_FALLBACK_URL = __ENV.WS_URL || "ws://localhost:4001/api/ws";
const PRODUCER_URL = __ENV.PRODUCER_URL || "http://localhost:4710";
const CONSUMERS = Number(__ENV.CONSUMERS || 200);
const READERS = Number(__ENV.READERS || 20);
const DURATION = __ENV.DURATION || "210s";
const DURATION_MS = parseDurationMs(DURATION) - 3000;
const AUTH_COOKIE_NAME = __ENV.AUTH_COOKIE_NAME || "tiq_session";
const VIEWER_EMAIL = __ENV.VIEWER_EMAIL || "arif.rahman@nx-sim.example";
const VIEWER_PASSWORD = __ENV.VIEWER_PASSWORD || "viewer-nx-01";
const E2E_SAMPLE_EVERY_MS = 5000;

/** DoD gate: p95 ingestion→board < 1 s at ×10 events. */
const ingestToBoard = new Trend("ingest_to_board_ms", true);
/** Transport leg only: gateway frame build (frame.ts) → client arrival. */
const wsTransport = new Trend("ws_transport_ms", true);
const boardFrames = new Counter("board_frames_received");

function parseDurationMs(text) {
  const match = /^(\d+)s$/.exec(text.trim());
  if (match) return Number(match[1]) * 1000;
  const fallback = Number(text);
  return Number.isFinite(fallback) ? fallback : 240000;
}

const scenarios = {
  consumers: {
    executor: "constant-vus",
    exec: "consumerSession",
    vus: CONSUMERS,
    duration: DURATION,
  },
};
if (READERS > 0) {
  scenarios.readers = {
    executor: "constant-vus",
    exec: "readerLoop",
    vus: READERS,
    duration: DURATION,
    startTime: "5s",
  };
}

export const options = {
  scenarios,
  // k6's in-process latency trend is NOT the DoD gate: on a small host the
  // generator starves its own VUs (measured negative clock deltas + p95
  // inflation vs the independent probe). The gate is evaluated from
  // probe-latency.json by the orchestrator (see load-report-f5.md).
};

export function setup() {
  const response = http.post(
    `${TIQ_BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: VIEWER_EMAIL, password: VIEWER_PASSWORD }),
    { headers: { "content-type": "application/json" } },
  );
  check(response, { "viewer login ok": (r) => r.status === 200 });
  if (response.status !== 200) {
    throw new Error(`viewer login failed with ${response.status}`);
  }
  const { token } = response.json();
  return { token };
}

export function consumerSession(data) {
  const mint = http.post(`${TIQ_BASE_URL}/api/v1/auth/ws-token`, null, {
    cookies: { [AUTH_COOKIE_NAME]: data.token },
  });
  const minted = check(mint, { "ws token ok": (r) => r.status === 200 });
  if (!minted) {
    sleep(1);
    return;
  }
  const wsUrl = (mint.json().url || WS_FALLBACK_URL).replace(/^http/, "ws");
  let lastSampleAt = 0;

  ws.connect(`${wsUrl}?token=${encodeURIComponent(mint.json().token)}`, {}, (socket) => {
    socket.on("open", () => {
      socket.send(JSON.stringify({ action: "subscribe", channel: "board" }));
    });
    socket.on("message", (raw) => {
      // ADR-0008: frames may arrive wrapped in a board.batch envelope (one
      // socket write per flush). Cheap prefilter accepts both shapes; JSON is
      // parsed once per MESSAGE, which also keeps the k6 JS loop cheap.
      if (typeof raw !== "string") return;
      if (!raw.includes('"lastEventId"')) return;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      const frames = parsed.type === "board.batch" ? parsed.payload.frames : [parsed];
      const now = Date.now();
      let sampleFrame = null;
      for (const frame of frames) {
        if (!frame.lastEventId) continue;
        boardFrames.add(1);
        if (!sampleFrame) sampleFrame = frame;
      }
      if (!sampleFrame || now - lastSampleAt < E2E_SAMPLE_EVERY_MS) return;
      lastSampleAt = now;
      const builtAt = Date.parse(sampleFrame.ts);
      if (Number.isFinite(builtAt)) wsTransport.add(now - builtAt);
      const appended = http.get(
        `${PRODUCER_URL}/append-time?id=${encodeURIComponent(sampleFrame.lastEventId)}`,
      );
      if (appended.status !== 200) return;
      const wallMs = Number(appended.json("wallMs"));
      if (Number.isFinite(wallMs) && wallMs > 0) {
        ingestToBoard.add(now - wallMs);
      }
    });
    socket.setTimeout(() => socket.close(), DURATION_MS);
  });
}

export function readerLoop(data) {
  const response = http.get(`${TIQ_BASE_URL}/api/v1/board`, {
    cookies: { [AUTH_COOKIE_NAME]: data.token },
    tags: { name: "GET board" },
  });
  check(response, { "board snapshot ok": (r) => r.status === 200 });
  sleep(1);
}

export function teardown() {
  // Results assembly happens in run-loadtest.mjs (k6 summary + producer manifest).
}
