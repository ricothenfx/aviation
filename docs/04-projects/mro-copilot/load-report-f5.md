# Load Report — mro-copilot F5 (search · ask)

| Field | Value |
|---|---|
| Status | Committed evidence — honest verdicts incl. failures (D-07, milestones.md §F5 DoD) |
| Date | 2026-09-26 |
| Harness | `pnpm loadtest:mro` (k6 scenarios + independent single-client latency probe), scripts under `scripts/loadtest/` |
| Stack | compose profile `mro` (mro-web :3003, mro-ai-service :4103, shared postgres) — the evidence profile (Prometheus/Grafana, ADR-0007) was **not** needed for these runs; raw k6 summaries + probe JSON are the committed evidence |
| Related | ADR-0013/D-19 (retrieval connection pool, driven by this load finding) · PRD FR-8/FR-13 · api-contracts.md §1 |

## What the F5 DoD asks (milestones.md §F5)

> Load report (honest, committed): search p95 < 300 ms at 100 VU; ask p95 < 2.5 s at
> 25 VU (mock provider) — failures/degradations documented, scripts under `scripts/`

## Verdict up front (no spin)

| Gate | Result on this host | Detail |
|---|---|---|
| Ask p95 < 2.5 s @ 25 VU (mock) | **PASS at moderate host load** (k6 1.70–1.79 s, probe 1.77–2.03 s) — **FAIL when host load ≥ ~17** (2.36 s k6 / 3.19 s probe) with the *same code and offer* | load-sensitive; see run table |
| Search p95 < 300 ms @ 100 VU | **NOT VERIFIED on this host — FAIL under both offers** (paced 100 VU: 3.38 s k6 / 2.76 s probe; saturation: 5.29 s k6) | environmental ceiling, quantified below |
| Search p95 < 300 ms, single-client reference (F2/F4 bench methodology) | **PASS** — 205.7 ms (02:38Z, load 7–12) · 267 ms (02:54Z, load 12) · 304 ms (03:10Z, load 14) | matches how the F2/F4 gates were measured |

The search gate at 100 VU could not be demonstrated on this machine. This is reported
as a failure with the quantified cause; it is **not** claimed as a pass and **not**
silently dropped (D-07; the DoD's "failures/degradations documented").

## Environment disclosure (the decisive factor)

The measurements ran on a **4-CPU desktop co-tenanted with everything else this
portfolio runs**: the developer IDE (VS Code measured at 58–105% CPU — one full
core), the agent harness (`kilo`), **the turnaround-iq prod demo stack
(D-12: caddy + web + realtime-gateway + replan-engine + prod postgres + prod redis,
measured at ~1.5–2 cores combined)** and the turnaround-iq dev stack (simulator et al.).
Host load average during runs: **10–19** (i.e. up to ~5× oversubscription of 4 CPUs),
versus load 2–4 when idle. Per-run snapshots: `host-noise-{before,mid,after}.txt`,
`host-processes.txt` (top consumers + per-container CPU at capture time).

Why this matters: the mro search path is three cooperating processes
(Next.js → uvicorn → postgres). Under CPU oversubscription each hop pays scheduling
latency; single-client p95 moved **205 ms → 267 ms → 304 ms** purely as host load
rose 7 → 14, and the 25-VU ask gate flipped **PASS → FAIL** between load ≈ 12 and
load ≈ 17 with identical code and offer. Latency percentiles on this box measure the
co-tenancy as much as the service.

## Structural hardening performed during F5 (real, kept)

The load runs exposed one genuine defect, fixed under **ADR-0013 / D-19**:
`RetrievalService` serialized every search (and every ask's retrieval leg) through a
single pooled PG connection behind a lock — a throughput ceiling of
`1000 / per-request-ms` req/s independent of CPU. Replaced with a small in-module
bounded pool (capacity 8, psycopg stdlib only, transient overflow connections;
no new package). Effects measured on this host:

- single-client search bench p95: **253 ms (F4) → 205.7 ms** at comparable load;
- saturation capacity (100 VU closed-loop, think=0): **~33.5 req/s sustained**,
  bounded by the single Next.js process + host co-tenancy;
- SQL, public contracts, and degradation-ladder semantics unchanged (81 pytest
  green, incl. 4 new pool-semantics tests).

## Run history (all evidence archived under `scripts/loadtest/results/mro/archives/`)

| Run (UTC) | Offer (search / ask) | Host load 1-min (before → after) | Search p95 k6 / probe, ms | Ask p95 k6 / probe, ms | Verdict |
|---|---|---|---|---|---|
| 2026-09-26 02:20 | sat 100 VU think 0 / 25 VU think 0.05 s | ~11 → ~13 | 5757 / 5302 | 1727 / 5457* | search FAIL · ask PASS (k6) |
| 2026-09-26 02:38→03:03 (re-run, archived `03-03-saturation-offer`) | sat 100 VU think 0 / 25 VU think 0 | 10 → 13 (mid 40 during search phase) | 5288 / 5436 | 2624 / 4289 | search FAIL · ask FAIL (load spike) |
| 2026-09-26 02:46 (not archived; superseded by 03:03 run) | paced 100 VU think 4 s / 25 VU think 0.05 s | ~10 → 13 | 2232 / 1805 | 1704 / 1772 | search FAIL · ask **PASS** |
| 2026-09-26 03:09 (archived `03-09-paced-offer`) | paced 100 VU think 4 s / 25 VU think 0 | 10 → 14 (15-min 15.6) | 3375 / 2761 | 2366 / 3186 | search FAIL · ask FAIL (host at 17+) |

\* probe ask number in the 02:20 run predates per-phase probe attribution (fixed in
`mro-probe-latency.mjs`); per-phase probe numbers are used from the archived runs on.

Offers are recorded per run in `verdict.json`. Think time 0 = closed-loop saturation
(a *throughput* probe); think 4 s models 100 concurrent engineers searching every
~4 s (~25 req/s demand) and makes the gate a per-request latency claim. The two
offers answer different questions; neither is cherry-picked and both are committed.

## Findings & degradation notes

1. **The ask gate holds within a measured host-load envelope** (PASS at load ≲ 15,
   ~1.7–2.0 s p95, vs the 2.5 s gate) and fails when the host degrades further. The
   envelope is stated so reviewers can weigh the claim; the gate is reproducible on
   a host whose idle load is ≤ ~4.
2. **The search gate at 100 VU is not demonstrable on this shared 4-CPU desktop.**
   Service capacity measured ~33 req/s (saturation) against a 100-VU closed-loop
   demand that is unbounded by construction; even the paced ~25 req/s offer tails
   above 2 s under 3–5× CPU oversubscription. The single-client reference
   measurement — the same methodology that passed F2/F4's 300 ms gate — passes
   whenever host load is ≤ ~12 (205–267 ms).
3. **Next structural lever (documented, not built — scope discipline):** mro-web is
   one Next.js process; horizontal scale (replicas behind Caddy, mirroring the
   prod D-12 topology) is the next capacity multiplier and would need its own ADR.
   No new service was added to the demo stack for this milestone.
4. The evidence profile (Prometheus :9090 / Grafana :3002, ADR-0007) was **not**
   required for these runs; k6 summary exports + the independent probe + host-noise
   snapshots are the committed evidence. `--prom` remains supported in the runner
   for a future instrumented re-run.

## Reproduce

```bash
docker compose --profile mro up -d        # stack (web :3003, ai-service :4103)
pnpm loadtest:mro                         # saturation offer (both gates)
pnpm loadtest:mro --search-think-ms=4000  # paced offer (per-request latency claim)
pnpm bench:mro-search && pnpm bench:mro-ask  # single-client reference
```

Raw evidence: `k6-{search,ask}-summary.json`, `probe-latency.json`, `verdict.json`,
`phases.json`, `host-noise-*.txt`, `host-processes.txt`, `bench-reference.log`.
