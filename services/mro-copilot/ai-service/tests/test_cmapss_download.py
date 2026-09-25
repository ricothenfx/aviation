"""Tamper test for the pinned C-MAPSS download (DoD: tampered fixture ⇒ hard
fail). Runs download.sh in verify-only mode against fixtures. The intact-file
happy path only runs where the pinned download exists (dev/compose) — CI's
python job stays hermetic (no dataset download), the compose job exercises
the real fetch."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[4] / "apps" / "mro-copilot" / "seed" / "cmapss" / "download.sh"
)
PINNED_TRAIN = "963b5e22825b34d8b21c69e1aeb4af3e647050eb672ee8834ba4b5d91d2de0f8"


def test_verifies_intact_pinned_files() -> None:
    assert SCRIPT.is_file()
    data_dir = SCRIPT.parent / "data"
    if not (data_dir / "train_FD001.txt").is_file():
        pytest.skip("pinned download not present in this environment (hermetic CI)")
    proc = subprocess.run(
        ["bash", str(SCRIPT)],
        env={"CMAPSS_VERIFY_ONLY": "1", "PATH": "/usr/bin:/bin:/usr/local/bin"},
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    assert "verified: 4 pinned files" in proc.stdout


def test_tampered_file_fails_hard(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    (data / "train_FD001.txt").write_text("1 1 tampered\n", encoding="utf-8")
    (data / "test_FD001.txt").write_text("also wrong\n", encoding="utf-8")
    (data / "RUL_FD001.txt").write_text("0\n", encoding="utf-8")
    (data / "readme.txt").write_text("tampered\n", encoding="utf-8")
    proc = subprocess.run(
        ["bash", str(SCRIPT)],
        env={
            "CMAPSS_VERIFY_ONLY": "1",
            "CMAPSS_DATA_DIR": str(data),
            "PATH": "/usr/bin:/bin:/usr/local/bin",
        },
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode != 0
    assert "FATAL" in proc.stderr
    assert "sha256 mismatch" in proc.stderr
    assert PINNED_TRAIN[:12] in proc.stderr  # names the expected pin
