"""RUL model registry + predictor (ADR-0011, api-contracts.md §3).

The registry owns the versioned artifact: `metrics.json` names the current
artifact file + sha256; the joblib payload is hash-verified AT LOAD TIME —
a missing artifact or hash mismatch means NO predictions are served
(architecture.md §6) and /readyz reports the RUL dependency down.

The predictor reads sensor history from PostgreSQL, computes features with
the SAME module the trainer used (mro_ai.features — ADR-0011 consequence),
and returns predictions that always carry provenance (FR-16: modelVersion +
modelSha256 on every RUL number; behavioral contract api-contracts.md §4).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import joblib

from mro_ai.features import MIN_CYCLES, SensorRow, features_for_cycle

logger = logging.getLogger("mro_ai.rul")

MODELS_DIR_ENV = "MRO_MODELS_DIR"
BAND_Z = 1.96  # ~95% two-sided normal quantile


class ModelNotLoadedError(RuntimeError):
    """Artifact missing/hash-mismatch/unreadable — mapped to 503
    MODEL_NOT_LOADED on the internal API (api-contracts.md §2)."""


class InsufficientHistoryError(RuntimeError):
    """Fewer than `minCycles` observed readings for the unit — mapped to 422
    INSUFFICIENT_HISTORY; the app composes latestRul: null (honesty case,
    D-15 precedent: missing data renders "—", never a fabricated number)."""


def default_models_dir() -> Path:
    override = os.environ.get(MODELS_DIR_ENV)
    if override:
        return Path(override)
    return Path(__file__).resolve().parent.parent / "models"


@dataclass(frozen=True)
class HistoryRow:
    """One DB history row — cycle + 21 sensor channels (unit id implied)."""

    cycle: int
    sensors: tuple[float, ...]


@dataclass(frozen=True)
class Prediction:
    unit_id: str
    cycle: int
    rul_cycles: int
    band_low: int
    band_high: int
    model_version: str
    model_sha256: str


@dataclass(frozen=True)
class ModelInfo:
    version: str
    sha256: str
    trained_at: str
    dataset: str
    metrics: dict[str, float]


class ModelRegistry:
    """Loads and verifies the artifact; thread-safe lazy singleton per app."""

    def __init__(self, models_dir: Path | None = None) -> None:
        self._models_dir = models_dir or default_models_dir()
        self._lock = threading.Lock()
        self._payload: dict[str, Any] | None = None
        self._sha256: str | None = None
        self._metrics: dict[str, Any] | None = None
        self._failure: str | None = None

    @property
    def models_dir(self) -> Path:
        return self._models_dir

    @property
    def failure_reason(self) -> str | None:
        return self._failure

    def ensure_loaded(self) -> tuple[dict[str, Any], str, dict[str, Any]]:
        """Return (payload, artifact sha256, metrics.json) or raise
        ModelNotLoadedError. Verified at load: metrics.json must name the
        artifact and the file bytes must match the pinned sha256."""
        with self._lock:
            if self._payload is not None:
                assert self._sha256 is not None and self._metrics is not None
                return self._payload, self._sha256, self._metrics
            self._failure = None
            metrics_path = self._models_dir / "metrics.json"
            try:
                metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
                artifact_rel = metrics["artifact"]["file"]
                expected_sha = metrics["artifact"]["sha256"]
            except (OSError, KeyError, ValueError) as err:
                self._failure = f"metrics.json unreadable in {self._models_dir}: {err}"
                raise ModelNotLoadedError(self._failure) from err

            artifact_path = self._models_dir / artifact_rel
            if not artifact_path.is_file():
                self._failure = f"artifact {artifact_path} not found"
                raise ModelNotLoadedError(self._failure)
            digest = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
            if digest != expected_sha:
                self._failure = f"artifact sha256 mismatch: expected {expected_sha}, found {digest}"
                raise ModelNotLoadedError(self._failure)
            try:
                payload = joblib.load(artifact_path)
                required = ("version", "channels", "minCycles", "residualStd", "model")
                missing = [k for k in required if k not in payload]
                if missing:
                    raise ValueError(f"artifact missing keys: {missing}")
            except Exception as err:
                self._failure = f"artifact unreadable: {err}"
                raise ModelNotLoadedError(self._failure) from err

            self._payload = payload
            self._sha256 = digest
            self._metrics = metrics
            logger.info(
                json.dumps(
                    {
                        "level": "info",
                        "module": "rul",
                        "msg": "model_loaded",
                        "version": payload["version"],
                        "sha256": digest,
                    }
                )
            )
            return payload, digest, metrics

    def is_loaded(self) -> bool:
        """True when the artifact is verified-loadable right now (readyz).
        Never raises."""
        try:
            self.ensure_loaded()
            return True
        except ModelNotLoadedError:
            return False

    def info(self) -> ModelInfo:
        _payload, sha, metrics = self.ensure_loaded()
        m = metrics.get("metrics", {})
        return ModelInfo(
            version=str(metrics.get("modelVersion", "")),
            sha256=sha,
            trained_at=str(metrics.get("trainedAt", "")),
            dataset=str(metrics.get("dataset", "")),
            metrics={
                "rmse": float(m.get("rmse", 0.0)),
                "nasaScore": float(m.get("nasaScore", 0.0)),
            },
        )


def _connect(database_url: str) -> Any:
    import psycopg

    return psycopg.connect(database_url, connect_timeout=3)


def fetch_history(database_url: str, unit_id: str, up_to_cycle: int | None) -> list[SensorRow]:
    """Sensor history for a unit (cycles ascending), optionally truncated."""
    query = (
        "select cycle, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, "
        "s11, s12, s13, s14, s15, s16, s17, s18, s19, s20, s21 "
        "from sensor_readings where unit_id = %(unit)s"
    )
    params: dict[str, object] = {"unit": unit_id}
    if up_to_cycle is not None:
        query += " and cycle <= %(cycle)s"
        params["cycle"] = up_to_cycle
    query += " order by cycle asc"
    with _connect(database_url) as conn, conn.cursor() as cur:
        cur.execute(query, params)
        rows = cur.fetchall() or []
    return [HistoryRow(cycle=int(r[0]), sensors=tuple(float(v) for v in r[1:])) for r in rows]


class RulService:
    """Prediction facade used by the internal routes."""

    def __init__(self, registry: ModelRegistry, database_url: str) -> None:
        self._registry = registry
        self._database_url = database_url

    def registry_info(self) -> ModelInfo:
        """Artifact provenance (raises ModelNotLoadedError when unusable)."""
        return self._registry.info()

    def registry(self) -> ModelRegistry:
        return self._registry

    def predict(self, unit_id: str, cycle: int | None = None) -> Prediction:
        payload, sha, _metrics = self._registry.ensure_loaded()
        model = payload["model"]
        channels = [int(c) for c in payload["channels"]]
        min_cycles = int(payload["minCycles"])
        residual_std = float(payload["residualStd"])

        rows = fetch_history(self._database_url, unit_id, cycle)
        if len(rows) < min_cycles:
            raise InsufficientHistoryError(
                f"unit {unit_id} has {len(rows)} readings; "
                f"{min_cycles} required before a prediction is honest"
            )
        target_cycle = rows[-1].cycle if cycle is None else cycle
        try:
            x = features_for_cycle(rows, target_cycle, channels)
        except ValueError as err:
            raise InsufficientHistoryError(f"unit {unit_id}: {err}") from err

        rul = float(model.predict(x.reshape(1, -1))[0])
        rul_int = max(0, round(rul))
        band_low = max(0, round(rul - BAND_Z * residual_std))
        band_high = round(rul + BAND_Z * residual_std)
        return Prediction(
            unit_id=unit_id,
            cycle=int(target_cycle),
            rul_cycles=rul_int,
            band_low=band_low,
            band_high=band_high,
            model_version=str(payload["version"]),
            model_sha256=sha,
        )


def units_with_readings(database_url: str) -> list[str]:
    """Unit ids present in sensor_readings (ascending)."""
    with _connect(database_url) as conn, conn.cursor() as cur:
        cur.execute("select distinct unit_id from sensor_readings order by unit_id asc")
        return [str(r[0]) for r in (cur.fetchall() or [])]


__all__ = [
    "BAND_Z",
    "MIN_CYCLES",
    "InsufficientHistoryError",
    "ModelInfo",
    "ModelNotLoadedError",
    "ModelRegistry",
    "Prediction",
    "RulService",
    "default_models_dir",
    "fetch_history",
    "units_with_readings",
]
