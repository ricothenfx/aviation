"""C-MAPSS file parsing + sample/data directory resolution (data-model.md §8).

Both the training CLI and the fleet seed read the same FD001 text shape:
whitespace-separated rows of `unit cycle setting1 setting2 setting3 s1..s21`.
Comment lines starting with `#` are skipped — the committed synthetic sample
uses them for its mandatory synthetic labeling (data-ethics.md §1/§2).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

N_SETTINGS = 3
N_SENSORS = 21
ROW_WIDTH = 2 + N_SETTINGS + N_SENSORS

CMAPSS_DATA_ENV = "MRO_CMAPSS_DATA_DIR"
CMAPSS_SAMPLE_ENV = "MRO_CMAPSS_SAMPLE_DIR"


class CmapssDataError(RuntimeError):
    """Dataset files missing or malformed — loud failure, never partial data."""


@dataclass(frozen=True)
class CmapssFiles:
    train_path: Path
    test_path: Path
    rul_path: Path | None
    dataset: str  # "fd001" | "sample"


@dataclass(frozen=True)
class Reading:
    """One sensor row — cycle plus the 21 sensor channels (settings ignored
    downstream: FD001 is single-condition, and the sample mirrors that)."""

    unit: int
    cycle: int
    sensors: tuple[float, ...]


def parse_file(path: Path) -> list[Reading]:
    """Parse one C-MAPSS-shaped text file; `#` comments are skipped."""
    readings: list[Reading] = []
    with path.open(encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) != ROW_WIDTH:
                raise CmapssDataError(
                    f"{path}:{lineno}: expected {ROW_WIDTH} fields, found {len(parts)}"
                )
            try:
                unit = int(parts[0])
                cycle = int(parts[1])
                sensors = tuple(float(v) for v in parts[2 + N_SETTINGS :])
            except ValueError as err:
                raise CmapssDataError(f"{path}:{lineno}: {err}") from err
            readings.append(Reading(unit, cycle, sensors))
    if not readings:
        raise CmapssDataError(f"{path}: no data rows")
    return readings


def parse_rul_file(path: Path) -> dict[int, int]:
    """Parse RUL_FD00x.txt — the NASA file holds ONE RUL value per line with
    the unit id implied by the line number (unit n = line n); the synthetic
    sample uses explicit `unit rul` pairs (comment headers allowed)."""
    out: dict[int, int] = {}
    line_no = 0
    with path.open(encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            line_no += 1
            parts = line.split()
            try:
                if len(parts) == 1:
                    out[line_no] = int(parts[0])
                elif len(parts) == 2:
                    out[int(parts[0])] = int(parts[1])
                else:
                    raise ValueError("expected one RUL value or a 'unit rul' pair")
            except ValueError as err:
                raise CmapssDataError(f"{path}:{lineno}: {err}") from err
    if not out:
        raise CmapssDataError(f"{path}: no RUL rows")
    return out


def sample_dir() -> Path:
    """Committed synthetic 3-unit sample (repo layout or env override)."""
    override = os.environ.get(CMAPSS_SAMPLE_ENV)
    if override:
        return Path(override)
    # mro_ai/cmapss.py → mro_ai → ai-service → mro-copilot → services → repo
    repo = Path(__file__).resolve().parents[4]
    return repo / "apps" / "mro-copilot" / "seed" / "cmapss" / "sample"


def data_dir() -> Path:
    """Downloaded (real) FD001 data location — download.sh output."""
    override = os.environ.get(CMAPSS_DATA_ENV)
    if override:
        return Path(override)
    repo = Path(__file__).resolve().parents[4]
    return repo / "apps" / "mro-copilot" / "seed" / "cmapss" / "data"


def resolve_files(dataset: str) -> CmapssFiles:
    """Locate train/test/RUL files for `fd001` (downloaded) or `sample`
    (committed synthetic). Missing real data raises with remediation hints —
    the download must be checksum-verified first (data-model.md §8)."""
    if dataset == "sample":
        base = sample_dir()
        files = CmapssFiles(
            train_path=base / "train_FD001.sample.txt",
            test_path=base / "test_FD001.sample.txt",
            rul_path=base / "RUL_FD001.sample.txt",
            dataset="sample",
        )
    elif dataset == "fd001":
        base = data_dir()
        files = CmapssFiles(
            train_path=base / "train_FD001.txt",
            test_path=base / "test_FD001.txt",
            rul_path=base / "RUL_FD001.txt",
            dataset="fd001",
        )
    else:
        raise CmapssDataError(f"unknown dataset {dataset!r} (expected 'fd001' or 'sample')")
    for p in (files.train_path, files.test_path):
        if not p.is_file():
            raise CmapssDataError(
                f"{p} not found — run apps/mro-copilot/seed/cmapss/download.sh first "
                "(checksum-verified) or train on the committed synthetic sample: "
                "python -m mro_ai.train --dataset sample"
            )
    return files


def group_by_unit(readings: list[Reading]) -> dict[int, list[Reading]]:
    """Group rows per unit, sorted by cycle (deterministic order)."""
    out: dict[int, list[Reading]] = {}
    for r in readings:
        out.setdefault(r.unit, []).append(r)
    for rows in out.values():
        rows.sort(key=lambda r: r.cycle)
    return out
