# ADR-0011: RUL Model = Gradient-Boosted Trees (scikit-learn) on Piecewise-Linear Targets

| Field | Value |
|---|---|
| Status | Accepted (user approval 2026-09-24, closing mro-copilot F0) |
| Date | 2026-09-24 |
| Supersedes | — |
| Related | D-03, D-07, ADR-0003, tech-stack.md §1, mro-copilot data-model.md §8, PRD §3 F-5 |

## Context

mro-copilot's engine-health feature predicts Remaining Useful Life (RUL) from the public
NASA C-MAPSS turbofan degradation dataset (Saxena & Goebel, 2008 — allowed per
data-ethics.md §1). The CAG ML Engineer JD (Req 7167) lists "PyTorch, scikit-learn".
The locked stack fixes Python 3.12 + FastAPI for AI serving but does not yet fix the ML
training/serving library. The model must be: reproducible from a committed seeded script,
trainable on CPU in minutes, servable from the small ai-service container, and honestly
reported against known baselines (data-ethics.md §4).

## Decision

RUL prediction uses a **scikit-learn `HistGradientBoostingRegressor`** trained on
per-engine **windowed degradation features** (last-cycle sensor values + rolling
mean/slope features over fixed windows) with the standard **piecewise-linear RUL target**
(clip at 125 cycles on FD001). Model artifacts are versioned
(`models/rul-{semver}-f{dataset}.joblib` + `metrics.json` + sha256), produced only by the
committed training CLI with a fixed seed, and loaded by the FastAPI predictor.

Reported metrics: RMSE and the asymmetric NASA scoring function on the FD001 test split,
next to published classical-ML baselines — bad numbers reported alongside good ones.

## Alternatives considered

1. **PyTorch LSTM/CNN (deep RUL literature standard)** — rejected for this build: larger
   dependency surface in the serving image, non-deterministic training defaults that work
   against the seed-and-hash reproducibility gate, and hyperparameter burden with no
   product payoff at portfolio scale. Honest expectation: an LSTM typically beats GBM on
   FD001 RMSE by a few cycles — the gap will be stated in the eval report rather than
   papered over (D-07 honesty). Revisit via new ADR if a deep model becomes the demo point.
2. **Survival analysis (Weibull AFT / random survival forests)** — rejected: better
   framing for censoring in real fleets, but C-MAPSS run-to-failure trajectories carry no
   censored labels, so the added machinery earns nothing here.
3. **Classical linear regression on last-cycle values** — kept as the committed baseline
   the GBM must beat, not the deliverable.

## Consequences

- (+) Full train → artifact → serve path is deterministic, CPU-only, seconds-fast, and
  explainable via per-feature contributions — a defensible MLOps story (versioning,
  evaluation, drift hook) without platform theater.
- (+) scikit-learn is explicitly in JD 7167 vocabulary; traceability stays honest.
- (−) Forfeits the last few RMSE points a tuned LSTM would buy; documented as a
  limitation with the literature pointer.
- (−) Feature engineering is hand-rolled (windowed slopes) — acceptable for C-MAPSS's
   21 sensor channels; a real fleet would need a feature store (out of scope).
