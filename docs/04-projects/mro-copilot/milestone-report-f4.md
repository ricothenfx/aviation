# Milestone Report — F4 · Engine Health (C-MAPSS → RUL)

**Status: DONE** — all Definition-of-Done items in `docs/04-projects/mro-copilot/milestones.md` §F4 met and verified on the live stack. All commits reference the document sections that guided each choice (AGENTS.md §3 discipline). Evidence: CI runs on the pushed commits; local verification battery recorded below.

## Scope delivered (milestones.md §F4)

1. **C-MAPSS seed** (`apps/mro-copilot/seed/cmapss/`)
   - `download.sh` verifies **per-file pinned sha256** on every fetch; tampered fixture ⇒ hard fail (pytest `test_cmapss_download.py`). Deviation from data-model.md §8's "(CMAPSSData.zip)" wording documented in §Deviations.
   - Committed **synthetic 3-unit sample** (`sample/`, clearly labeled `# SYNTHETIC`, deterministic generator `generate-sample.py`, seed 42) — CI is hermetic, never downloads NASA data (data-ethics.md §1).
2. **`sensor_readings` TimescaleDB hypertable** (migration 0004, data-model.md §8): `recorded_at = 2000-01-01T00:00:00Z + cycle × 1 day` enforced by a CHECK constraint; unique `(unit_id, cycle, recorded_at)` (hypertable requires the partition column in unique constraints — equivalent to `(unit_id, cycle)` by the deterministic mapping); 30-day chunks; compression policy after 90 synthetic days (data-model.md §6).
3. **GBM training CLI** (`python -m mro_ai.train`, ADR-0011/D-17): `HistGradientBoostingRegressor(random_state=42, early_stopping=False)`, piecewise-RUL clip 125, windowed features (last + rolling mean5 + OLS slope10 per degradation channel). OMP threads pinned **before** numpy/sklearn import ⇒ **same seed ⇒ byte-identical artifact** (CI-tested: `test_same_seed_yields_identical_artifact_sha256`).
4. **Versioned artifact committed**: `services/mro-copilot/ai-service/models/rul-1.0.0-fd001.joblib` (sha256 `f612eb43…902a23`, pinned in committed `metrics.json`, hash-verified at load; mismatch ⇒ `MODEL_NOT_LOADED`).
5. **`metrics.json` honesty (D-07)**: FD001 test **RMSE 18.49 ≤ 24 ✓**, NASA score **786.5**, MAE 13.98, residual σ 18.34 — tabled next to published baselines (RF 16.14, GBT 15.02, LSTM 16.14, CNN 18.45, DCNN 12.61) with explicit commentary that this deliberately reproducible GBM trails tuned deep models and is chosen for production shape, not leaderboard RMSE (data-ethics §4: honest reporting, no benchmark fabrication).
6. **Predict/score-fleet endpoints** (api-contracts.md §1/§3): every RUL number carries `modelVersion` + `modelSha256` (FR-16, §4 behavioral contract — fleet snapshot, unit detail, score results, alerts). `MODEL_NOT_LOADED` 503 wired to the real artifact state; `/readyz` (ai-service **and** app) gates `model: up` (architecture.md §6 — F4 tightening the F1 placeholder).
7. **Maintenance-window alert engine + lifecycle** (FR-17/FR-18): app-side rule (RUL ≤ unit threshold, one open alert per unit), `leadCycles` = predicted remaining cycles at raise (≥ 5 in fixtures, tested); strict `raised → acknowledged → resolved` chain — invalid transitions 409 `LIFECYCLE_CONFLICT`, resolve requires a mandatory note (400 otherwise), RBAC matrix viewer/engineer(+reviewer ladder), `alert.*` append-only audit events via the 0002 trigger (integration-tested).
8. **Fleet dashboard** (PRD F-5, ui-design-system.md §5/§7/§8): KPI tiles, model-provenance strip (version/sha/trainedAt/dataset/NASA score), fleet table, per-unit **trend chart** (Recharts, ±1.96σ band, labeled axes with units, threshold reference line), alert queue with ack/resolve. All four mandatory states; simulated-data footer (app shell) + **C-MAPSS citation** (FR-3); synthetic units badged "Synthetic sample" (data-ethics §2). Screenshots: `docs/04-projects/mro-copilot/assets/f4-fleet-dashboard.png`, `f4-unit-trend.png`, `f4-alerts.png` (script `scripts/screenshots/mro-f4.mjs`).
9. **Contract & tests**: cross-runtime fixture `rul_contract.json` parsed by pydantic AND zod (predict/score-fleet/backfill/model-info field parity); INSUFFICIENT_HISTORY 422 composes `latestRul: null` → UI renders "—", never 0 (D-15 precedent, integration + e2e pinned).

## Honest deviations & implementation notes

- **Pin mechanism (data-model.md §8)**: the original `CMAPSSData.zip` is no longer directly fetchable without NASA's interactive portal. `download.sh` therefore pins the four FD001 files **individually** from a documented public mirror. Authenticity evidence recorded in `seed/cmapss/README.md`: byte-equality across two independent mirrors + structure matching the published data card (20,631 train rows / 100 units; 13,096 test rows; 100 RUL values — exactly as data-model.md §6 states). Doc §8 updated accordingly (additive clarification). Honest alternative considered and rejected: reconstructing "the original zip" ourselves would fabricate a provenance artifact.
- **Fleet seed size (data-model.md §2/§6 "~23k sensor_readings rows")**: the real FD001 *test* split is 13,096 rows; with the 226-row synthetic sample the seeded fleet carries **13,322** rows (§6's ~23k matches neither split alone; the train split is run-to-failure and wrong for a fleet snapshot). Seeded from the test split per §2's "seeded from C-MAPSS test split" — the row-count approximation in §6 was treated as stale, not silently reinterpreted.
- **leadCycles semantics**: defined as *predicted remaining cycles at raise* (the lead time before projected removal). Fixture NX-E202 raises with leadCycles = 20 ≥ 5 ✓ (FR-18).
- **Uncertainty band**: ±1.96 × FD001 test residual σ — an honest homoscedastic approximation, stated in metrics.json and the UI ("band ±1.96σ"); no fabricated per-point confidence.
- **Backfill (added during F4, api-contracts.md §3)**: the first scoring of a unit previously produced a single-point trend; `POST /internal/v1/rul/backfill` now offline-scores ≤ 12 evenly spaced historical checkpoints in one bulk round trip with **no look-ahead** (feature windows stop at each cycle; out-of-range cycles skipped, never extrapolated). `rul_predictions` is latest-known per `(unit_id, cycle)` (migration 0005 unique index; upsert on re-score) — replaces duplicate-append behavior caught in local verification.
- **`rul_predictions` history retention**: superseded same-cycle predictions are overwritten (not append-only) — this table is serving state; the append-only audit trail lives in `audit_events` (unchanged).

## Local verification battery (all green)

| Gate | Result |
|---|---|
| Python: ruff + ruff format + mypy strict + pytest | **74 passed** (reproducibility, tamper, backfill no-lookahead, provenance, committed-RMSE gate) |
| Workspace lint + typecheck (strict) | clean |
| Unit tests (vitest) | 38 passed (incl. `evaluateAlert` rules, zod RUL fixture parity) |
| Integration (compose stack) | **67 passed** (RBAC matrix, provenance invariant, honesty NX-E203, alert lifecycle + 409s, append-only `alert.*` audit, degradation ladder, ask/sign-off, search contract, idempotency) |
| `pnpm eval:mro` | recall@5 **0.9231 ≥ 0.85** ✓ |
| `pnpm eval:mro:full` | refusal 1.00 · citation validity 1.00 · grounded 0.8462 ≥ 0.80 · replay ✓ |
| `pnpm bench:mro-search` | p95 **253 ms < 300** ✓ |
| `pnpm bench:mro-ask` | p95 **331 ms < 2500** ✓ |
| `pnpm test:e2e:mro` | **5 passed** (3 F3 + 2 F4) |
| Fresh-DB migration chain 0000→0005 | proven via dropped-and-recreated `mro_copilot` (incl. Timescale extension, hypertable, compression policy, CHECK constraint) |
| score-fleet (fresh fleet, first scoring incl. backfill) | 200 in ~6 s; 102 scored; NX-E203 insufficient; 12-point trend per unit; alerts deduped |

## Guidance (document sections per major choice)

- GBM + piecewise clip + seeded artifact: ADR-0011, D-17 · PRD F-4/F-5 · milestones.md §F4 DoD.
- Two-runtime split (training/serving in ai-service; alert rules in the app): ADR-0012, architecture.md §2/§3/§6.
- Provenance contract: api-contracts.md §4, PRD FR-16.
- Honesty: D-07 (metrics vs baselines), D-15 precedent (null → "—"), data-ethics.md §1/§2/§4, PRD FR-17/FR-18.
- Hypertable + deterministic time: data-model.md §2/§6/§8; ui-design-system.md §8 (labeled axes).
- UI states/tokens/screens: ui-design-system.md §2/§5/§7/§8/§9; Recharts per tech-stack.md §1.
- CI gates: milestones.md §F4 DoD (reproducibility CI test, alert-integration coverage) — mro.yml gained the named reproducibility step and fleet/artifact smoke checks; e2e.yml runs the F4 specs unchanged.
- Out of scope left for F5 (milestones.md §F5): `POST /api/v1/admin/ingest` (still deferred per milestone-report-f3.md §Deviations), mro web metrics page, load test.
