"""Training CLI (ADR-0011) — the F4 reproducibility gate + artifact contract.

DoD: "Training reproducibility test: same seed ⇒ identical artifact sha256
(CI)". The training data is the committed synthetic 3-unit sample (clearly
labeled synthetic per data-ethics.md) — CI never downloads C-MAPSS.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from mro_ai.cmapss import resolve_files
from mro_ai.train import (
    PIECEWISE_RUL_CLIP,
    SEED,
    run_training,
    sha256_file,
)


@pytest.fixture(scope="module")
def trained(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path, str]:
    out = tmp_path_factory.mktemp("train")
    artifact, metrics = run_training("sample", "0.0.1", out)
    return artifact, metrics, sha256_file(artifact)


def test_same_seed_yields_identical_artifact_sha256(
    trained: tuple[Path, Path, str], tmp_path: Path
) -> None:
    """THE reproducibility gate: rerunning training on the same committed
    sample with the same seed must produce byte-identical artifacts."""
    artifact, _, sha = trained
    again, _ = run_training("sample", "0.0.1", tmp_path / "rerun")
    assert sha256_file(again) == sha
    assert artifact.name == "rul-0.0.1-sample.joblib"


def test_artifact_payload_contract(trained: tuple[Path, Path, str]) -> None:
    import joblib

    artifact, _, sha = trained
    payload = joblib.load(artifact)
    for key in ("version", "dataset", "seed", "channels", "minCycles", "residualStd", "model"):
        assert key in payload, f"artifact missing {key}"
    assert payload["version"] == "0.0.1"
    assert payload["dataset"] == "sample"
    assert payload["seed"] == SEED
    assert payload["piecewiseRulClip"] == PIECEWISE_RUL_CLIP
    assert isinstance(payload["channels"], list) and payload["channels"]
    # No wall-clock data may enter the artifact (reproducibility surface).
    assert "trainedAt" not in payload and "trained_at" not in payload


def test_metrics_json_is_the_honest_report(trained: tuple[Path, Path, str], tmp_path: Path) -> None:
    artifact, metrics_path, sha = trained
    metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
    assert metrics["artifact"]["sha256"] == sha
    assert metrics["artifact"]["file"] == artifact.name
    assert metrics["seed"] == SEED
    assert metrics["piecewiseRulClip"] == PIECEWISE_RUL_CLIP
    # Honesty fields (D-07): baselines table + commentary always shipped.
    assert isinstance(metrics["baselines"], list) and len(metrics["baselines"]) >= 3
    assert metrics.get("commentary")
    for key in ("rmse", "nasaScore", "mae", "residualStd"):
        assert key in metrics["metrics"]
    # trainedAt is report metadata — never inside the artifact bytes.
    assert "trainedAt" in metrics


def test_sample_training_is_labeled_as_non_comparable(trained: tuple[Path, Path, str]) -> None:
    _, metrics_path, _ = trained
    metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
    assert metrics["dataset"] == "sample"
    assert "NOT comparable" in metrics["commentary"]


def test_fd001_committed_metrics_meet_the_rmse_gate() -> None:
    """The COMMITTED artifact's metrics.json must satisfy the DoD gate
    (FD001 test RMSE ≤ 24) — CI asserts the shipped evidence, not a claim."""
    committed = Path(__file__).resolve().parents[1] / "models" / "metrics.json"
    assert committed.is_file(), "committed metrics.json missing"
    metrics = json.loads(committed.read_text(encoding="utf-8"))
    assert metrics["dataset"] == "fd001"
    assert metrics["metrics"]["rmse"] <= 24.0
    # Provenance closure: the committed artifact file must exist and match the
    # pinned sha256 so the serving registry will load it.
    artifact = committed.parent / metrics["artifact"]["file"]
    assert artifact.is_file()
    assert sha256_file(artifact) == metrics["artifact"]["sha256"]


def test_sample_files_resolve() -> None:
    files = resolve_files("sample")
    assert files.train_path.is_file() and files.test_path.is_file()
