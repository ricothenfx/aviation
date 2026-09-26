# Final Eval Report — mro-copilot F5 (consolidated)

| Field | Value |
|---|---|
| Status | Final consolidated evidence at the shipped corpus/fixture versions (milestones.md §F5 DoD item 2) |
| Date | 2026-09-26 |
| Fixtures | golden-QA v1 (52 cases) · refusal set v1 · corpus digest `c8f16cf6ed49…` (62 manuals, 630 chunks) |
| Runs | `pnpm eval:mro` + `pnpm eval:mro:full` re-run 2026-09-26 against the live compose stack; run persisted to the reviewer eval dashboard (runId `93274f4c-95a6-4fad-b0f8-f6c2d0253e50`) |
| Reports | `apps/mro-copilot/eval-reports/{retrieval-v1,full-v1}.{json,md}` · `grounding-calibration.json` |

## F3 gates re-run at final versions — all green

| Gate | Target | Final run | |
|---|---|---|---|
| Golden retrieval recall@5 | ≥ 0.85 | **0.9231** | ✅ (hit-rate@5 0.9231, MRR 0.8458) |
| Refusal accuracy (refusal set) | 100% | **1.00** | ✅ |
| Citation validity (produced answers) | 100% | **1.00** | ✅ (132 citations, all resolve to retrieved chunks) |
| Grounded answer rate (golden QA, mock provider) | ≥ 0.80 | **0.8462** | ✅ |
| Idempotent replay of the full eval | no duplicate | **true** | ✅ |
| Ask latency (mock provider, eval harness) | reference | p50 157 ms · p95 714 ms | ✅ (load-gate discussion: load-report-f5.md) |

## RUL model metrics (alongside, per DoD; committed `metrics.json` + artifact)

| Field | Value |
|---|---|
| Model | HistGradientBoostingRegressor, piecewise-linear RUL clip 125, seed 42 (ADR-0011/D-17) |
| Version / artifact | **1.0.0** · `rul-1.0.0-fd001.joblib` · sha256 `f612eb43…902a23` (pinned in metrics.json, verified at load) |
| FD001 test RMSE | **18.49** ≤ 24 ✅ |
| NASA score | **786.5** |
| MAE / residual σ | 13.98 / 18.34 (uncertainty band = ±1.96σ, homoscedastic — stated, not fabricated) |

### Published baselines next to it (D-07 honesty; full table + commentary in metrics.json)

| Model | FD001 RMSE |
|---|---|
| GBT (classical, tuned — Zhang et al. 2021 survey) | 15.02 |
| Random Forest (Camci PHM'09) | 16.14 |
| LSTM (deep, standard — Zheng et al. 2017) | 16.14 |
| CNN (deep — Babu et al. 2016) | 18.45 |
| **mro-copilot GBM 1.0.0 (this repo, deterministic, CPU)** | **18.49** |
| DCNN (deep, tuned — Li et al. 2018) | 12.61 |

Honest reading: this model deliberately trades a few RMSE cycles for full
determinism (same seed ⇒ byte-identical artifact, CI-tested), versioned provenance on
every prediction, and CPU-only serving. It does not beat tuned deep models; that gap
is stated here, in the UI model strip, and in metrics.json. A deep-model revisit
requires a new ADR.

## Where each gate lives in CI

- recall@5 / refusal / citation-validity / grounded-rate: `pnpm eval:mro:full` in
  `.github/workflows/mro.yml` (mock provider, offline-safe).
- Artifact reproducibility (`same seed ⇒ identical sha256`) + committed-RMSE gate:
  pytest lane (`tests/test_rul_train.py`).
- Latency discussion (300 ms / 2.5 s at VU): `docs/04-projects/mro-copilot/load-report-f5.md`
  — ask verified within a stated host-load envelope; search 100-VU not verifiable on
  the shared dev desktop (documented degradation, D-07).
