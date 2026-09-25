"""Degradation-ladder + contract tests for the search route (DoD F2, FR-7).

With the embedding provider KILLED (gateway None), /internal/v1/retrieval/
search must return `mode: "lexical"` and stay within the wire contract.
The DB layer is faked — SQL correctness is proven by test_retrieval_sql plus
the integration lane against the real compose stack.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from mro_ai.config import load_config
from mro_ai.gateway import Gateway
from mro_ai.internal.schemas import RetrievalSearchResponse
from mro_ai.main import create_app
from mro_ai.retrieval import RetrievalService

FIXTURE = Path(__file__).parent / "fixtures" / "retrieval_contract.json"


class FakeCursor:
    def __init__(self, rows: list[tuple]) -> None:
        self._rows = rows

    def fetchall(self) -> list[tuple]:
        return self._rows


class FakeConnection:
    """Records SQL; returns canned rows (one row set for any query)."""

    def __init__(self, rows: list[tuple]) -> None:
        self._rows = rows
        self.closed = False
        self.statements: list[str] = []
        self.params: list[dict[str, Any] | tuple] = []

    def execute(self, statement: str, params: Any = None) -> FakeCursor:
        self.statements.append(statement)
        self.params.append(params)
        return FakeCursor(self._rows)

    def close(self) -> None:
        self.closed = True


ROW = (
    "018f3c1e-0000-7000-8000-000000000001",  # chunk_id
    0.0263,  # fused RRF score
    "018f3c1e-0000-7000-8000-0000000000aa",  # manual_id
    "AMM",
    "29-11-00-000-401",
    "29",
    "NX320 AMM · ATA 29 · 29-11-00 · Task 29-11-00-000-401 · hydraulic accumulator",
    17,
    "Rev 37",
    "2026-03-01",
    "Torque the [[accumulator]] attach bolts to 34.5 Nm.",
)


def make_client(
    gateway: Gateway | None,
    rows: list[tuple],
) -> tuple[TestClient, FakeConnection]:
    app = create_app(gateway=gateway)
    # The lifespan would set config/retrieval in a real deployment; tests pin
    # both explicitly so no DB is required (SQL is covered by integration).
    if not hasattr(app.state, "config"):
        app.state.config = load_config(
            {"AI_SERVICE_TOKEN": "test-token-0123456789abcdef", "LLM_PROVIDER": "mock"}
        )
    fake_conn = FakeConnection(rows)
    app.state.retrieval = RetrievalService(
        database_url="postgresql://unused",
        gateway=gateway,
        connection_factory=lambda _url: fake_conn,  # type: ignore[arg-type,return-value]
    )
    client = TestClient(app)
    return client, fake_conn


AUTH = {"Authorization": "Bearer test-token-0123456789abcdef"}


def search(client: TestClient, payload: dict) -> Any:
    return client.post("/internal/v1/retrieval/search", json=payload, headers=AUTH)


def test_search_with_provider_killed_degrades_to_lexical() -> None:
    client, fake_conn = make_client(gateway=None, rows=[ROW])
    res = search(client, {"query": "accumulator torque", "k": 5})
    assert res.status_code == 200
    body = res.json()
    assert body["mode"] == "lexical"
    assert len(body["results"]) == 1
    assert body["results"][0]["chunkId"] == ROW[0]
    assert body["results"][0]["score"] == ROW[1]
    assert body["results"][0]["docType"] == "AMM"
    assert body["results"][0]["page"] == 17
    # degraded run must not attempt a query embedding (no embedding param)
    assert fake_conn.statements
    executed = fake_conn.params[0]
    assert "embedding" not in executed


def test_search_with_mock_provider_runs_hybrid() -> None:
    client, _ = make_client(gateway=Gateway.from_env({"LLM_PROVIDER": "mock"}), rows=[ROW])
    res = search(client, {"query": "accumulator torque", "k": 8})
    assert res.status_code == 200
    body = res.json()
    assert body["mode"] == "hybrid"


def test_search_request_rejects_k_above_20() -> None:
    client, _ = make_client(gateway=None, rows=[])
    res = search(client, {"query": "x", "k": 25})
    assert res.status_code == 422


def test_search_passes_filters_to_sql() -> None:
    client, fake_conn = make_client(gateway=None, rows=[ROW])
    res = search(
        client,
        {
            "query": "torque",
            "k": 5,
            "filters": {"docTypes": ["AMM"], "ataChapters": ["29"]},
        },
    )
    assert res.status_code == 200
    params = fake_conn.params[0]
    assert params["doc_types"] == ["AMM"]
    assert params["ata_chapters"] == ["29"]


def test_response_parses_committed_contract_fixture() -> None:
    """Pydantic side of the retrieval wire contract (zod twin in the app)."""
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    model = RetrievalSearchResponse.model_validate(fixture["response"])
    assert model.mode == fixture["response"]["mode"]
    dumped = model.model_dump(by_alias=True)
    assert list(dumped.keys()) == fixture["responseFields"]
    hit_fields = list(model.results[0].model_dump(by_alias=True).keys())
    assert hit_fields == fixture["hitFields"]


def test_ingest_refuses_to_start_without_provider() -> None:
    """architecture.md §6: embedding provider unavailable at ingest → loud fail."""
    client, _ = make_client(gateway=None, rows=[])
    res = client.post("/internal/v1/ingest", headers=AUTH)
    assert res.status_code == 503
    assert res.json()["code"] == "PROVIDER_UNAVAILABLE"
