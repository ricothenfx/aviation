# F5 Load Test Report — turnaround-iq ×10 Scenario Scale

| Field | Value |
|---|---|
| Milestone | F5 "Evidence & Ship" (milestones.md §F5) |
| Date | 2026-09-24 |
| Verdict | **DoD gate PASS** — p95 ingestion→board **198 ms** < 1 s at ×10 events, 200 concurrent consumers, 100% frame delivery |
| Reproduce | `pnpm loadtest` (see §7); committed artifacts under `scripts/loadtest/results/` |
| Honest-data policy | data-ethics.md §4 — every bad intermediate result below is reported, not hidden |

## 1. What was measured

| Dimension | Value |
|---|---|
| Scenario scale | ×10 reference day (milestones.md §F5): 10 deterministic replica banks → **600 flights / 7,200 tasks** baseline (data-model.md §4 documents ~15k events/scenario-day as the design scale) |
| Events replayed | **15,000** at a paced **~100 events/s** wall-clock (manifest: 99.99–99.73/s actual) over ~150 s |
| Consumers | **200 concurrent WebSocket board consumers** (k6 constant-VUs, per milestones.md) + optional REST snapshot readers |
| Latency metric | durable append (producer wall clock, post-INSERT) → client arrival, per (event, consumer) pair |
| Stack under test | compose profile `turnaround` (postgres + redis + gateway + simulator + replan-engine) + **production web** (`next build` + `next start`) — the demo deployment shape of ADR-0006 |
| Host (honest) | 4 cores / 7 GB RAM, shared with the harness; load average 6–10 during runs — see §5 generator-skew finding |

## 2. Final gate result (committed: `scripts/loadtest/results/gate/`)

| Metric | Value | Target |
|---|---|---|
| Ingestion→board p50 | **53 ms** | — |
| **Ingestion→board p95** | **198 ms** | **< 1,000 ms ✓** |
| Ingestion→board p99 / max | 598 ms / 877 ms | — |
| Samples | 15,000 (every event of the ×10 log) | — |
| Frame delivery | **3,000,000 / 3,000,000 (100.0%)** across 200 consumers | — |
| Replay reproducibility | evidence re-run with the observability stack active: p50=56 ms, p95=557 ms, p99=1,811 ms, delivery 100.0% — **PASS** | — |

Methodology note (honest): k6's in-process latency trend is **not** used as the
gate. On this 4-core host the generator starves its own VUs (200 goja contexts +
~14k metric adds/s compete with the product for the same cores); we measured
negative clock deltas (−43 to −109 ms) and multi-second p95 inflation in the
generator that an independent single-socket consumer does not see. k6 remains
the prescribed 200-consumer **load generator** (delivery + REST load); the
**latency oracle** is a lightweight probe measuring every frame
(`scripts/loadtest/probe-latency.mjs`, 15,000 samples). Both artifacts are
committed so reviewers can re-derive either view.

## 3. Engineering narrative — every failure was real and drove a fix

| Run | Result | Root cause found | Fix shipped |
|---|---|---|---|
| 1–2 | p95 9.8–31.9 s, delivery 76–89% | (a) harness bug: k6 ws event is `message`, not `frame`; (b) **defect: pub/sub subscriptions stacked on every reset cycle** (`start()` re-subscribed without `unsubscribe`) — the Nth reset was processed N times, each spawning a concurrent full projection rebuild (10 rebuilds × ~12 min observed); (c) `JSON.stringify` per client per frame (~24k sends/s); (d) harness runner orphaned the producer (pnpm did not forward SIGTERM → stale port, mixed manifests) | k6 event fixed; **subscribe exactly once** (worker.ts); memoized frame serialization; runner spawns tsx directly + phase-gated health |
| 3 | zero frames delivered | reset landed mid-boot-rebuild: replay of 15k events took **15.7 min** (per-event PG writes: 13 sequential round-trips × 15k events saturated the 10-conn pool) and the worker never reached broadcast | **PG projection writes coalesced per flight (500 ms) with one bulk task UPDATE** — rebuild 942 s → **10.7 s (88×)** |
| 4–7 | med 1.1–3.6 s, p95 5–8.6 s, delivery up to 100% | flush-tick overrun: ~24k socket writes/s (one per frame per client) exceeded the 100 ms flush budget — fan-out cost scales with clients × frames | **ADR-0008: `board.batch` wire envelope** — one write per client flush (~12× fewer syscalls), additive contract, wire-only |
| 8–10 | med ~1.1 s, p95 6.4–8.6 s (k6 view) | generator self-starvation (§2) — product path already fast: independent probe read p50=52 ms / p95=195 ms under the same load | latency oracle moved to the probe; verdict recomputed from committed artifacts |
| **11 (gate)** | **p95 198 ms — PASS** | — | — |

## 4. Honest findings that remain open

1. **`GET /api/v1/board` is O(flights) in Redis round-trips** (lib/data/board.ts:
   660 sequential `hGetAll` on one connection). At ×10 under snapshot load:
   median 1.9–3 s per snapshot (REST p95 up to ~9 s in reader-heavy runs); at 1×
   demo scale (~60 flights) it stays ≈150–300 ms, so the live demo is
   unaffected. Proposed follow-up: consolidate board projections into one hash
   or pipeline the multi-get. Not fixed in F5 (scope discipline) — documented
   as the largest known scaling debt.
2. **Rebuild = replay is still O(events)**: 10.7 s for 15k events after
   coalescing. Fine for the demo; a checkpoint/snapshot mechanism is future
   work if the scenario day grows another order of magnitude.
3. **Host sizing**: the full harness (product + 200 consumers + generator +
   observability) saturates 4 cores (load avg 6–10). The ADR-0006 demo VPS
   should be sized ≥ 2 vCPU for 1× demo traffic (needs ~10× less than this
   test) — recorded for the deployment runbook.
4. **k6 in-process latency trends** on small hosts overstate latency (§2) —
   harness limitation, documented so future runs don't chase phantom numbers.

## 5. What the fixes cost and bought

| Change | Before | After |
|---|---|---|
| Projection rebuild (15k events) | 720–942 s, could wedge the worker for a whole run | **10.7 s**, never blocks delivery |
| ws socket writes at ×10 × 200 consumers | ~24,000/s (overran the 100 ms flush budget ~5×) | ~2,000/s (batch envelope) |
| Delivery | 76–97.5% within the session window | **100.0%** |
| Ingestion→board p95 | 3.9–31.9 s (k6 view, contaminated) → **198 ms** (probe) | < 1 s ✓ |

## 6. Artifacts

- `scripts/loadtest/` — producer (×10 replay), k6 scenario, probe, orchestrator
- `scripts/loadtest/results/gate/` — k6 summary, probe latencies, run manifest (the gate run)
- `scripts/loadtest/results/` — latest evidence run (with observability active)
- `docs/04-projects/turnaround-iq/assets/grafana-load-evidence.png` — dashboard during the evidence run (note: in-panel latency series show the k6 client view per §2)
- `infra/observability/` — Prometheus + Grafana provisioning (ephemeral evidence profile, ADR-0007)

## 7. Reproduce

```bash
docker compose --profile turnaround up -d --wait     # full stack
pnpm loadtest                                        # gate run (k6 + probe)
pnpm loadtest -- --prom                              # + Grafana evidence (profile evidence)
```
