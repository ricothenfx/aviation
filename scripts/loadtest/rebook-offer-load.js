// rebook-ai F5 k6 scenario: offer pipeline at ×10 disruption scale
// (milestones.md §F5, load-report-f5.md). VU 1..N each injects a cancellation
// on ONE replica flight (one inject per flight — the domain reality); the
// first POLLERS VUs then act as the agent console, polling the queue snapshot
// every POLL_MS until each flight in their slice shows a ranked offer.
//
// The visibility metric is wall clock from the poller's wave start — every
// inject lands inside the first ~1 s of VU startup (verified per run from the
// event log and recorded in the load report), so the approximation is bounded
// by the k6 start spread and disclosed there.
//
// Offers per flight come from the same pipeline the F2 benchmark measures
// (scripts/benchmarks/rebook-offer-pipeline.mjs), scaled to the replica wave.
// The custom trend `rebook_offer_visibility_ms` and Rate `rebook_offers_visible`
// are exported; the runner computes the p95 < 10 s gate from the summary so
// the export stays the single evidence artifact. A flight whose offers never
// show up is a FAILED sample, never silently dropped (data-ethics.md §4).

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE = __ENV.REBOOK_BASE_URL || "http://localhost:3004";
const FLIGHTS = (__ENV.FLIGHTS || "")
  .split(",")
  .map((f) => f.trim())
  .filter(Boolean);
const POLLERS = Number(__ENV.POLLERS || 1);
const POLL_S = Number(__ENV.POLL_MS || 150) / 1000;
const TIMEOUT_MS = Number(__ENV.OFFER_TIMEOUT_MS || 30000);
// Paced offer (tiq ×10 replay methodology): VU N injects N*PACE_MS after its
// start, modelling a disruption front rolling through the schedule. 0 = the
// saturation offer (all injects at once — the hardest case).
const PACE_MS = Number(__ENV.PACE_MS || 0);

const visibility = new Trend("rebook_offer_visibility_ms", true);
const visible = new Rate("rebook_offers_visible");
const injectOk = new Rate("rebook_inject_ok");

export const options = {
  // One wave: one VU per flight, one iteration each — every flight is injected
  // exactly once (k6 __ITER is per-VU, so shared-iterations would re-inject the
  // first flights repeatedly; per-vu-iterations maps __VU 1:1 to FLIGHTS).
  // NOTE: response bodies MUST NOT be discarded — the console poller reads the
  // queue snapshot body (a previous draft discarded them and silently blinded
  // the poller; recorded in load-report-f5.md).
  scenarios: {
    wave: {
      executor: "per-vu-iterations",
      vus: FLIGHTS.length,
      iterations: 1,
      maxDuration: "180s",
    },
  },
  // The gate is computed runner-side from the summary export; these thresholds
  // only hard-fail k6 when the wave itself breaks down.
  thresholds: {
    rebook_inject_ok: ["rate>0.99"],
  },
  insecureSkipTLSVerify: true,
};

function login(email, password) {
  const res = http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({ email, password }), {
    headers: { "Content-Type": "application/json" },
  });
  check(res, { "login ok": (r) => r.status === 200 });
  const cookie = res.headers["Set-Cookie"] || "";
  return cookie.split(";")[0];
}

export function setup() {
  if (FLIGHTS.length === 0) {
    throw new Error("FLIGHTS env is empty — the runner exports the replica flight list");
  }
  const supervisor = login("grace.tan@nx-sim.example", "supervisor-nx-01");
  const agent = login("amir.hassan@nx-sim.example", "agent-nx-01");
  return { supervisor, agent };
}

export default function (data) {
  const waveStart = Date.now();
  const myIndex = (__VU - 1) % FLIGHTS.length;
  const flightNo = FLIGHTS[myIndex];
  // Paced offer: this VU's inject is scheduled at its index slot.
  const scheduledAt = waveStart + myIndex * PACE_MS;
  const waitMs = scheduledAt - Date.now();
  if (waitMs > 0) sleep(waitMs / 1000);

  const inject = http.post(
    `${BASE}/api/v1/scenario/inject`,
    JSON.stringify({ scenario: "cancellation", flightNo }),
    {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `loadtest-wave-${__VU}-${flightNo}`,
        cookie: data.supervisor,
      },
    },
  );
  if (!check(inject, { "inject 201": (r) => r.status === 201 })) {
    injectOk.add(false);
    visible.add(false);
    return;
  }
  injectOk.add(true);
  if (__VU > POLLERS) return; // injector-only VU: wave load, no console storm

  // Console slice: this poller watches the flights at its round-robin index.
  // Each slice flight is measured from its SCHEDULED inject time (epoch ms),
  // so the pacing is subtracted out of the visibility metric.
  const slice = FLIGHTS.filter((_, i) => i % POLLERS === __VU - 1);
  const pending = new Map(
    slice.map((f) => {
      const i = FLIGHTS.indexOf(f);
      return [f, waveStart + i * PACE_MS];
    }),
  );
  let polls = 0;
  while (pending.size > 0 && Date.now() - waveStart < TIMEOUT_MS + FLIGHTS.length * PACE_MS) {
    const snap = http.get(`${BASE}/api/v1/queue`, { headers: { cookie: data.agent } });
    polls += 1;
    // Transport errors and 5xx happen under the burst — they count against
    // visibility latency but must not abort the iteration (a failed poll is
    // a retry, never a crash).
    if (snap.status === 200 && snap.body) {
      try {
        const items = snap.json("items") || [];
        for (const [f, start] of [...pending]) {
          const found = items.some((item) => item.flightNo === f && item.offerState === "proposed");
          if (found) {
            visibility.add(Date.now() - start);
            visible.add(true);
            pending.delete(f);
          }
        }
      } catch {
        /* malformed body — keep polling */
      }
    }
    sleep(POLL_S);
  }
  for (let i = 0; i < pending.size; i += 1) {
    visible.add(false); // honest failure — offers never became visible in time
  }
}
