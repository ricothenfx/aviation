"""Windowed degradation features for RUL (ADR-0011).

The feature code that trains is the code that serves (ADR-0011 consequence,
data-model.md §8): both the training CLI and the FastAPI predictor call
`features_for_cycle` over a unit's sensor history. Deterministic, pure numpy.

Feature set per sensor channel c selected in the artifact spec:
  - last value at cycle t            → f"{c}_last"
  - rolling mean over last 5 cycles  → f"{c}_mean5"
  - OLS slope over last 10 cycles    → f"{c}_slope10" (per-cycle units)
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Protocol

import numpy as np

FEATURE_NAME_PATTERN = "{sensor}_{kind}"


class SensorRow(Protocol):
    """Structural row shape shared by file readings (int unit ids) and DB
    history rows (fictional string unit ids): both expose cycle + sensors."""

    @property
    def cycle(self) -> int: ...

    @property
    def sensors(self) -> tuple[float, ...]: ...


def selected_channels(readings_by_unit: Mapping[int, Sequence[SensorRow]]) -> list[int]:
    """Sensor channels (1-based) with non-constant values across the corpus.

    Constant channels carry no degradation signal; dropping them is computed
    from the training corpus (deterministic for fixed data) and stored in the
    artifact so serving selects exactly the same channels.
    """
    if not readings_by_unit:
        return []
    n_sensors = len(next(iter(readings_by_unit.values()))[0].sensors)
    columns = np.empty((sum(len(v) for v in readings_by_unit.values()), n_sensors))
    row = 0
    for rows in readings_by_unit.values():
        for r in rows:
            columns[row] = r.sensors
            row += 1
    keep = columns.std(axis=0) > 1e-9
    return [i + 1 for i in range(n_sensors) if keep[i]]


def cycle_window(rows: Sequence[SensorRow], cycle: int) -> tuple[list[SensorRow], int]:
    """Rows at or before `cycle` (the training/serving observation window).

    Returns the window and the number of cycles of history it spans
    (last - first + 1). An unknown cycle yields an empty window.
    """
    upto = [r for r in rows if r.cycle <= cycle]
    if not upto:
        return [], 0
    history = upto[-1].cycle - upto[0].cycle + 1
    return upto, history


def features_for_cycle(
    rows: Sequence[SensorRow], cycle: int, channels: list[int]
) -> np.ndarray[Any, Any]:
    """Feature vector for one observation (unit state at `cycle`).

    Raises ValueError when the history is shorter than the slope window —
    callers gate on `min_cycles` first (insufficient history ⇒ latestRul null,
    never a fabricated prediction).
    """
    upto, _history = cycle_window(rows, cycle)
    if len(upto) < SLOPE_WINDOW:
        raise ValueError(
            f"insufficient history at cycle {cycle}: {len(upto)} rows < {SLOPE_WINDOW}"
        )
    values = np.array([r.sensors for r in upto])  # (n, 21)
    tail = values[-SLOPE_WINDOW:]
    x = np.arange(1, SLOPE_WINDOW + 1, dtype=float)

    feats: list[float] = []
    for c in channels:
        col = tail[:, c - 1]
        last = col[-1]
        mean5 = col[-MEAN_WINDOW:].mean()
        # OLS slope: cov(x, y) / var(x); var(x) is constant here.
        slope = float(((x - x.mean()) * (col - col.mean())).sum() / ((x - x.mean()) ** 2).sum())
        feats.extend([float(last), mean5, slope])
    return np.array(feats, dtype=float)


MEAN_WINDOW = 5
SLOPE_WINDOW = 10
MIN_CYCLES = SLOPE_WINDOW

FEATURES_PER_CHANNEL = 3


def feature_names(channels: list[int]) -> list[str]:
    names: list[str] = []
    for c in channels:
        for kind in ("last", "mean5", "slope10"):
            names.append(FEATURE_NAME_PATTERN.format(sensor=c, kind=kind))
    return names


def training_table(
    readings_by_unit: Mapping[int, Sequence[SensorRow]], channels: list[int], clip: int
) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any]]:
    """Per-cycle supervised table for run-to-failure trajectories.

    Labels are the piecewise-linear RUL target (clip at 125 cycles on FD001,
    ADR-0011): rul = max_cycle - cycle, clipped.
    """
    xs: list[np.ndarray[Any, Any]] = []
    ys: list[float] = []
    for _unit, rows in readings_by_unit.items():
        max_cycle = rows[-1].cycle
        # Skip the first MIN_CYCLES - 1 observations (row-count gate — the same
        # rule serving applies; contiguous C-MAPSS rows make it equivalent to
        # a cycle gate).
        for r in rows[MIN_CYCLES - 1 :]:
            xs.append(features_for_cycle(rows, r.cycle, channels))
            ys.append(float(min(max_cycle - r.cycle, clip)))
    if not xs:
        raise ValueError("training table is empty — trajectories too short")
    return np.vstack(xs), np.array(ys, dtype=float)
