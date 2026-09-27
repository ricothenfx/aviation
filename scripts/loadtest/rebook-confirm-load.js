// rebook-ai F5 k6 scenario: N-way confirm concurrency with exactly-one-effect
// (milestones.md §F5, load-report-f5.md). The runner builds the test set from
// PostgreSQL (replica offers only — load-run data) and hands it to k6 via the
// TESTSET env JSON. Each offer is raced by RACERS virtual users arriving as
// simultaneously as k6 allows:
//
//   mode "same":     every racer sends the SAME Idempotency-Key
//                    → §5: identical stored response replayed, exactly one
//                    confirmation + one saga + one charge + one boarding pass.
//   mode "distinct": every racer sends its OWN key
//                    → §5: exactly one 201, the losers 409
//                    IDEMPOTENCY_CONFLICT, and still exactly one effect.
//
// HTTP codes alone prove nothing — the runner re-verifies the effects in
// PostgreSQL via scripts/loadtest/rebook-verify-effects.sql after the wave.

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.REBOOK_BASE_URL || "http://localhost:3004";
const TESTSET = JSON.parse(__ENV.TESTSET || "[]");
const RACERS = Number(__ENV.RACERS || 8);
const START_DELAY_MS = Number(__ENV.START_DELAY_MS || 2500);

const latency = new Trend("rebook_confirm_latency_ms", true);
const created = new Counter("rebook_confirm_201");
const conflict = new Counter("rebook_confirm_409");
const replayed = new Counter("rebook_confirm_replayed");
const serverErrors = new Counter("rebook_confirm_5xx");
const other = new Counter("rebook_confirm_other");

export const options = {
  scenarios: {
    race: {
      // Exactly (offers × racers) one-shot VUs; the barrier is the shared
      // startAt epoch below (k6 has no native barrier; residual skew is
      // bounded by the spin loop — the DB invariants are what must hold).
      executor: "per-vu-iterations",
      vus: TESTSET.length * RACERS,
      iterations: 1,
      maxDuration: "120s",
    },
  },
  discardResponseBodies: true,
  insecureSkipTLSVerify: true,
};

export function setup() {
  if (TESTSET.length === 0) {
    throw new Error("TESTSET env is empty — the runner exports the confirm test set");
  }
  const res = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({ email: "amir.hassan@nx-sim.example", password: "agent-nx-01" }),
    { headers: { "Content-Type": "application/json" } },
  );
  check(res, { "agent login ok": (r) => r.status === 200 });
  const cookie = (res.headers["Set-Cookie"] || "").split(";")[0];
  return { cookie, startAt: Date.now() + START_DELAY_MS };
}

export default function (data) {
  // VU mapping: racersPerOffer contiguous blocks (VU 1..R → offer 0, …).
  const racerIdx = (__VU - 1) % RACERS;
  const offer = TESTSET[Math.floor((__VU - 1) / RACERS)];
  if (!offer) return;

  // Spin to the shared start epoch so the racers land as one burst.
  while (Date.now() < data.startAt) sleep(0.02);

  const key =
    offer.mode === "same"
      ? `loadtest-confirm-${offer.offerId}`
      : `loadtest-confirm-${offer.offerId}-racer-${racerIdx}`;
  const t0 = Date.now();
  const res = http.post(
    `${BASE}/api/v1/pax/offers/${offer.offerId}/confirm`,
    JSON.stringify({ optionId: offer.optionId }),
    {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        cookie: data.cookie,
      },
    },
  );
  latency.add(Date.now() - t0);
  const replayedHeader = res.headers["Idempotency-Replayed"];
  if (res.status === 201) created.add(1);
  else if (res.status === 409) conflict.add(1);
  else if (res.status >= 500) serverErrors.add(1);
  else other.add(1);
  if (replayedHeader) replayed.add(1);
  check(res, {
    "no 5xx": (r) => r.status < 500,
    "2xx or 409 only": (r) => (r.status >= 200 && r.status < 300) || r.status === 409,
  });
}
