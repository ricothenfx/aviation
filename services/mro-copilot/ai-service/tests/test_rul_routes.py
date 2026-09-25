"""RUL serving (api-contracts.md §3, ADR-0011): registry, provenance,
MODEL_NOT_LOADED, INSUFFICIENT_HISTORY, and the cross-runtime fixture."""

from __future__ import annotations

import json
from contextlib import nullcontext
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from mro_ai.config import load_config
from mro_ai.gateway import Gateway
from mro_ai.internal.schemas import RulBackfillResponse, RulPrediction, RulScoreFleetResponse
from mro_ai.main import create_app
from mro_ai.rul import ModelNotLoadedError, ModelRegistry

TOKEN = "test-token-0123456789abcdef"
AUTH = {"Authorization": f"Bearer {TOKEN}"}

FIXTURE = Path(__file__).parent / "fixtures" / "rul_contract.json"


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("MRO_MODELS_DIR", str(Path(__file__).resolve().parents[1] / "models"))
    from mro_ai import main as main_module

    monkeypatch.setattr(main_module, "check_postgres", lambda _url: True)
    monkeypatch.setattr(main_module, "check_pgvector", lambda _url: True)
    app = create_app(config=load_config({"AI_SERVICE_TOKEN": TOKEN}), gateway=Gateway.from_env({}))
    return TestClient(app, raise_server_exceptions=False)


def _stub_history(monkeypatch: pytest.MonkeyPatch, rows: int, ramp: bool = True) -> None:
    import mro_ai.rul as rul_module

    # No database in unit tests: the fetch layer is stubbed below.
    monkeypatch.setattr(rul_module, "_connect", lambda _url: nullcontext())

    def fake_history_on(conn: object, unit_id: str, up_to_cycle: int | None) -> list:
        return [
            rul_module.HistoryRow(
                cycle=c,
                sensors=tuple([100.0 + (0.5 * c if ramp else 0.0)] + [float(10 + c)] * 20),
            )
            for c in range(1, rows + 1)
        ]

    monkeypatch.setattr(rul_module, "_fetch_history_on", fake_history_on)


def test_model_info_carries_provenance(client: TestClient) -> None:
    res = client.get("/internal/v1/model", headers=AUTH)
    assert res.status_code == 200
    body = res.json()
    assert body["version"]
    assert len(body["sha256"]) == 64
    assert body["dataset"] in ("fd001", "sample")
    assert set(body["metrics"]) == {"rmse", "nasaScore"}


def test_predict_requires_artifact_and_returns_provenance(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_history(monkeypatch, rows=40)
    res = client.post("/internal/v1/rul/predict", headers=AUTH, json={"unitId": "NX-E101"})
    assert res.status_code == 200
    body = res.json()
    # Behavioral contract (§4): any RUL number carries full provenance.
    assert set(body) == {
        "unitId",
        "cycle",
        "rulCycles",
        "bandLow",
        "bandHigh",
        "modelVersion",
        "modelSha256",
    }
    assert len(body["modelSha256"]) == 64
    assert body["bandLow"] <= body["rulCycles"] <= body["bandHigh"]
    assert body["rulCycles"] >= 0


def test_predict_at_explicit_cycle_uses_truncated_history(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import mro_ai.rul as rul_module

    seen: list[int | None] = []
    _stub_history(monkeypatch, rows=40)
    stub = rul_module._fetch_history_on

    def spy(conn: object, unit_id: str, up_to_cycle: int | None) -> list:
        seen.append(up_to_cycle)
        return stub(conn, unit_id, up_to_cycle)

    monkeypatch.setattr(rul_module, "_fetch_history_on", spy)
    monkeypatch.setattr(rul_module, "_connect", lambda _url: nullcontext())
    res = client.post(
        "/internal/v1/rul/predict", headers=AUTH, json={"unitId": "NX-E101", "cycle": 12}
    )
    assert res.status_code == 200
    assert seen == [12]
    assert res.json()["cycle"] == 12


def test_predict_insufficient_history_is_422(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_history(monkeypatch, rows=6)
    res = client.post("/internal/v1/rul/predict", headers=AUTH, json={"unitId": "NX-E203"})
    assert res.status_code == 422
    body = res.json()
    assert body["code"] == "INSUFFICIENT_HISTORY"
    assert body["requestId"]


def test_predict_without_artifact_is_503_model_not_loaded(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from mro_ai import main as main_module

    monkeypatch.setenv("MRO_MODELS_DIR", str(tmp_path))
    monkeypatch.setattr(main_module, "check_postgres", lambda _url: True)
    monkeypatch.setattr(main_module, "check_pgvector", lambda _url: True)
    app = create_app(config=load_config({"AI_SERVICE_TOKEN": TOKEN}), gateway=Gateway.from_env({}))
    client = TestClient(app, raise_server_exceptions=False)
    res = client.post("/internal/v1/rul/predict", headers=AUTH, json={"unitId": "NX-E101"})
    assert res.status_code == 503
    body = res.json()
    assert body["code"] == "MODEL_NOT_LOADED"


def test_registry_rejects_hash_mismatch(tmp_path: Path) -> None:
    import joblib

    (tmp_path / "metrics.json").write_text(
        json.dumps(
            {
                "modelVersion": "9.9.9",
                "dataset": "fd001",
                "trainedAt": "2026-01-01T00:00:00Z",
                "artifact": {"file": "rul-9.9.9-fd001.joblib", "sha256": "0" * 64},
                "metrics": {"rmse": 1.0, "nasaScore": 1.0},
            }
        ),
        encoding="utf-8",
    )
    joblib.dump({"version": "9.9.9"}, tmp_path / "rul-9.9.9-fd001.joblib")
    registry = ModelRegistry(tmp_path)
    with pytest.raises(ModelNotLoadedError, match="sha256 mismatch"):
        registry.info()


def test_score_fleet_reports_insufficient_units(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import mro_ai.rul as rul_module

    real = rul_module.fetch_history

    def mixed(database_url: str, unit_id: str, up_to_cycle: int | None) -> list:
        if unit_id.endswith("203"):
            return real(database_url, unit_id, up_to_cycle)[:6]
        return real(database_url, unit_id, up_to_cycle)

    # Real DB is unavailable in unit tests — return synthetic rows instead.
    def fake_bulk(conn: object, unit_ids: list[str]) -> dict:
        return {
            unit_id: [
                rul_module.HistoryRow(cycle=c, sensors=tuple([100.0 + 0.5 * c] + [10.0 + c] * 20))
                for c in range(1, (6 if unit_id.endswith("203") else 40) + 1)
            ]
            for unit_id in unit_ids
        }

    monkeypatch.setattr(rul_module, "_fetch_history_bulk", fake_bulk)
    monkeypatch.setattr(rul_module, "_connect", lambda _url: nullcontext())
    res = client.post(
        "/internal/v1/rul/score-fleet",
        headers=AUTH,
        json={"unitIds": ["NX-E201", "NX-E202", "NX-E203"]},
    )
    assert res.status_code == 200
    body = RulScoreFleetResponse.model_validate(res.json())
    assert [p.unit_id for p in body.results] == ["NX-E201", "NX-E202"]
    assert body.insufficient_history == ["NX-E203"]
    assert len(body.model_sha256) == 64
    for prediction in body.results:
        assert isinstance(prediction, RulPrediction)
        assert prediction.model_version == body.model_version


def test_backfill_scores_explicit_cycles_without_lookahead(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import mro_ai.rul as rul_module

    def fake_bulk(conn: object, unit_ids: list[str]) -> dict:
        return {
            unit_id: [
                rul_module.HistoryRow(cycle=c, sensors=tuple([100.0 + 0.5 * c] + [10.0 + c] * 20))
                for c in range(1, 41)
            ]
            for unit_id in unit_ids
        }

    monkeypatch.setattr(rul_module, "_fetch_history_bulk", fake_bulk)
    monkeypatch.setattr(rul_module, "_connect", lambda _url: nullcontext())
    res = client.post(
        "/internal/v1/rul/backfill",
        headers=AUTH,
        json={"entries": [{"unitId": "NX-E202", "cycles": [12, 20, 40, 99]}]},
    )
    assert res.status_code == 200
    body = RulBackfillResponse.model_validate(res.json())
    # cycle 99 exceeds the 40-row history -> dropped, never extrapolated.
    assert [p.cycle for p in body.results] == [12, 20, 40]
    assert body.skipped == []
    for prediction in body.results:
        assert prediction.model_version == body.model_version
        assert len(prediction.model_sha256) == 64


def test_backfill_skips_short_history_units(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import mro_ai.rul as rul_module

    monkeypatch.setattr(rul_module, "_fetch_history_bulk", lambda conn, ids: {})
    monkeypatch.setattr(rul_module, "_connect", lambda _url: nullcontext())
    res = client.post(
        "/internal/v1/rul/backfill",
        headers=AUTH,
        json={"entries": [{"unitId": "NX-E203", "cycles": [12]}]},
    )
    assert res.status_code == 200
    body = RulBackfillResponse.model_validate(res.json())
    assert body.results == []
    assert body.skipped == ["NX-E203"]


def test_rul_routes_require_bearer_token(client: TestClient) -> None:
    assert client.post("/internal/v1/rul/predict", json={"unitId": "u"}).status_code == 401
    assert client.get("/internal/v1/model").status_code == 401


def test_cross_runtime_fixture_parses_pydantic_side() -> None:
    fixture: dict[str, Any] = json.loads(FIXTURE.read_text(encoding="utf-8"))
    prediction = RulPrediction.model_validate(fixture["predictResponse"])
    dumped = prediction.model_dump(by_alias=True)
    assert list(dumped.keys()) == fixture["predictFields"]
    assert len(dumped["modelSha256"]) == 64
    fleet = RulScoreFleetResponse.model_validate(fixture["scoreFleetResponse"])
    assert list(fleet.model_dump(by_alias=True).keys()) == fixture["scoreFleetFields"]
    assert fixture["scoreFleetResponse"]["insufficientHistory"] == ["NX-E203"]
