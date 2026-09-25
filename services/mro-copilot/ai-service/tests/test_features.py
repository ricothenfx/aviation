"""Windowed feature engineering (ADR-0011) — train/serve parity rules."""

from __future__ import annotations

import numpy as np
import pytest

from mro_ai.cmapss import Reading
from mro_ai.features import (
    MEAN_WINDOW,
    MIN_CYCLES,
    SLOPE_WINDOW,
    features_for_cycle,
    selected_channels,
    training_table,
)


def make_unit(unit: int, cycles: int, base: float = 1.0) -> list[Reading]:
    """Linear ramp on sensor 1, flat elsewhere — easy to assert against."""
    return [
        Reading(
            unit=unit,
            cycle=c,
            sensors=tuple([base + 0.1 * c] + [5.0] * 20),  # s1 ramps, s2..s21 flat
        )
        for c in range(1, cycles + 1)
    ]


def test_selected_channels_drops_constant_channels() -> None:
    units = {1: make_unit(1, 30)}
    channels = selected_channels(units)
    assert 1 in channels  # ramping
    assert all(c != 2 for c in channels)  # flat
    assert len(channels) == 1


def test_features_last_mean_slope_are_exact() -> None:
    rows = make_unit(1, 20)
    x = features_for_cycle(rows, 20, [1])
    last, mean5, slope = x[0], x[1], x[2]
    tail = [r.sensors[0] for r in rows[-SLOPE_WINDOW:]]
    assert last == pytest.approx(tail[-1])
    assert mean5 == pytest.approx(np.mean(tail[-MEAN_WINDOW:]))
    # OLS slope over an exact linear ramp is the ramp step (0.1/cycle).
    assert slope == pytest.approx(0.1, abs=1e-9)


def test_features_are_deterministic() -> None:
    rows = make_unit(1, 20)
    a = features_for_cycle(rows, 20, [1])
    b = features_for_cycle(rows, 20, [1])
    assert np.array_equal(a, b)


def test_insufficient_history_raises() -> None:
    rows = make_unit(1, MIN_CYCLES - 1)
    with pytest.raises(ValueError, match="insufficient"):
        features_for_cycle(rows, MIN_CYCLES - 1, [1])


def test_history_is_truncated_at_the_requested_cycle() -> None:
    rows = make_unit(1, 30)
    x_at_10 = features_for_cycle(rows, 10, [1])
    assert x_at_10[0] == pytest.approx(rows[9].sensors[0])


def test_training_table_applies_piecewise_clip() -> None:
    rows = make_unit(1, 300)  # max RUL 299 → clipped at 125
    units = {1: rows}
    channels = selected_channels(units)
    x, y = training_table(units, channels, 125)
    assert len(x) == len(y) == 300 - (MIN_CYCLES - 1)
    assert y.max() == 125.0
    assert y[0] == 125.0  # deep in the plateau
    assert y[-1] == 0.0  # run-to-failure: RUL reaches 0 at the final cycle
