"""C-MAPSS parsing + dataset resolution (data-model.md §8)."""

from __future__ import annotations

from pathlib import Path

import pytest

from mro_ai.cmapss import (
    CmapssDataError,
    group_by_unit,
    parse_file,
    parse_rul_file,
    resolve_files,
)


def test_parses_the_committed_synthetic_sample() -> None:
    files = resolve_files("sample")
    assert "# SYNTHETIC" in files.train_path.read_text(encoding="utf-8").splitlines()[0]
    readings = parse_file(files.train_path)
    units = group_by_unit(readings)
    assert set(units) == {201, 202, 203}
    # Contiguous per-cycle rows starting at cycle 1.
    for rows in units.values():
        assert [r.cycle for r in rows] == list(range(1, len(rows) + 1))
        for r in rows:
            assert len(r.sensors) == 21


def test_skips_comment_lines_and_rejects_malformed_rows(tmp_path: Path) -> None:
    p = tmp_path / "mini.txt"
    p.write_text(
        "# SYNTHETIC header\n"
        + " ".join(["1", "1", "0", "0", "100", *(["1.0"] * 21)])
        + "\n\n"
        + " ".join(["1", "2", "0", "0", "100", *(["2.0"] * 21)])
        + "\n",
        encoding="utf-8",
    )
    rows = parse_file(p)
    assert [r.cycle for r in rows] == [1, 2]
    assert rows[0].sensors == tuple([1.0] * 21)

    bad = tmp_path / "bad.txt"
    bad.write_text("1 2 3\n", encoding="utf-8")
    with pytest.raises(CmapssDataError):
        parse_file(bad)


def test_rul_file_supports_both_formats(tmp_path: Path) -> None:
    """NASA file: one value per line (unit = line number). Sample: pairs."""
    nasa = tmp_path / "RUL_FD001.txt"
    nasa.write_text("112\n98\n69\n", encoding="utf-8")
    assert parse_rul_file(nasa) == {1: 112, 2: 98, 3: 69}

    sample = tmp_path / "RUL_FD001.sample.txt"
    sample.write_text("# header\n201 120\n202 20\n", encoding="utf-8")
    assert parse_rul_file(sample) == {201: 120, 202: 20}


def test_fd001_resolution_requires_download(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MRO_CMAPSS_DATA_DIR", str(tmp_path))
    with pytest.raises(CmapssDataError, match="download.sh"):
        resolve_files("fd001")
