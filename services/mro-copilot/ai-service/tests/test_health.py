"""Health, readiness and internal embed endpoint behaviour (fastapi TestClient)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from mro_ai.config import load_config
from mro_ai.gateway import Gateway
from mro_ai.main import create_app

TOKEN = "test-token-0123456789abcdef"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    from mro_ai import main as main_module

    monkeypatch.setattr(main_module, "check_postgres", lambda _url: True)
    monkeypatch.setattr(main_module, "check_pgvector", lambda _url: True)
    app = create_app(config=load_config({"AI_SERVICE_TOKEN": TOKEN}), gateway=Gateway.from_env({}))
    return TestClient(app, raise_server_exceptions=False)


def test_healthz(client: TestClient) -> None:
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_readyz_reports_all_dependencies(client: TestClient) -> None:
    res = client.get("/readyz")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ready"
    assert body["dependencies"] == {
        "postgres": "up",
        "pgvector": "up",
        "model": "up",  # F4: the committed artifact loads and hash-verifies
        "provider": "up",
    }


def test_readyz_reports_model_not_loaded(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    """A missing artifact fails the RUL dependency (architecture.md §6)."""
    from mro_ai import main as main_module

    monkeypatch.setenv("MRO_MODELS_DIR", str(tmp_path))  # no metrics.json here
    monkeypatch.setattr(main_module, "check_postgres", lambda _url: True)
    monkeypatch.setattr(main_module, "check_pgvector", lambda _url: True)
    app = create_app(config=load_config({"AI_SERVICE_TOKEN": TOKEN}), gateway=Gateway.from_env({}))
    client = TestClient(app, raise_server_exceptions=False)
    res = client.get("/readyz")
    assert res.status_code == 503
    body = res.json()
    assert body["status"] == "degraded"
    assert body["dependencies"]["model"] == "not_loaded"


def test_readyz_degrades_when_postgres_down(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from mro_ai import main as main_module

    monkeypatch.setattr(main_module, "check_postgres", lambda _url: False)
    res = client.get("/readyz")
    assert res.status_code == 503
    body = res.json()
    assert body["status"] == "degraded"
    assert body["dependencies"]["postgres"] == "down"


def test_embed_requires_bearer_token(client: TestClient) -> None:
    res = client.post("/internal/v1/embed", json={"texts": ["hello"]})
    assert res.status_code == 401
    wrong = client.post(
        "/internal/v1/embed", json={"texts": ["hi"]}, headers={"Authorization": "Bearer nope"}
    )
    assert wrong.status_code == 401


def test_embed_is_deterministic_and_shaped(client: TestClient) -> None:
    payload = {"texts": ["Hydraulic reservoir pressurization check."]}
    first = client.post("/internal/v1/embed", json=payload, headers=AUTH)
    second = client.post("/internal/v1/embed", json=payload, headers=AUTH)
    assert first.status_code == 200
    assert second.status_code == 200
    body_first: dict[str, Any] = first.json()
    assert body_first == second.json()
    assert list(body_first.keys()) == ["model", "vectors", "usage"]
    assert body_first["model"] == "mock-hashed-ngram-384"
    assert len(body_first["vectors"][0]) == 384
    assert "inputTokens" in body_first["usage"]


def test_embed_batch_preserves_order(client: TestClient) -> None:
    payload = {"texts": ["alpha bravo", "charlie delta", "echo foxtrot"]}
    res = client.post("/internal/v1/embed", json=payload, headers=AUTH)
    assert res.status_code == 200
    body = res.json()
    assert len(body["vectors"]) == 3
    individual = [
        client.post("/internal/v1/embed", json={"texts": [t]}, headers=AUTH).json()["vectors"][0]
        for t in payload["texts"]
    ]
    assert body["vectors"] == individual


def test_embed_validates_batch_contract(client: TestClient) -> None:
    empty = client.post("/internal/v1/embed", json={"texts": []}, headers=AUTH)
    assert empty.status_code == 422
    blank = client.post("/internal/v1/embed", json={"texts": [""]}, headers=AUTH)
    assert blank.status_code == 422
