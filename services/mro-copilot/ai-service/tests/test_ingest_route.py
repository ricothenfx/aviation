"""Ingest route contract tests (api-contracts.md §1 Admin/Ingest + §3).

Hermetic: `run_ingest` is monkeypatched — the real ingest job and its SQL are
covered by the integration lane against the real compose postgres and by
test_corpus_chunker. What is pinned here is the WIRE SHAPE: 200 carries the
camelCase report; a concurrent run is 409 INGEST_IN_PROGRESS in the RFC-7807
problem envelope (not a bare {"detail"}), matching how the app maps it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from mro_ai.config import load_config
from mro_ai.gateway import Gateway
from mro_ai.ingest import IngestInProgressError, IngestReport
from mro_ai.internal import routes as internal_routes
from mro_ai.main import create_app

AUTH = {"Authorization": "Bearer test-token-0123456789abcdef"}

REPORT = IngestReport(
    corpus_digest="a" * 64,
    embedding_model="mock-hashed-ngram-384",
    manuals_touched=62,
    chunks_new=0,
    chunks_changed=0,
    chunks_unchanged=630,
    chunks_removed=0,
    duration_ms=643,
)


def make_client(monkeypatch: pytest.MonkeyPatch, outcome: Any) -> TestClient:
    async def fake_run_ingest(
        database_url: str, corpus_dir: Path, gateway: Gateway
    ) -> IngestReport:
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(internal_routes, "run_ingest", fake_run_ingest)
    monkeypatch.setattr(
        internal_routes, "default_corpus_dir", lambda: Path("/unused/corpus"), raising=True
    )
    app = create_app(
        config=load_config(
            {"AI_SERVICE_TOKEN": "test-token-0123456789abcdef", "LLM_PROVIDER": "mock"}
        ),
        gateway=Gateway.from_env({"LLM_PROVIDER": "mock"}),
    )
    # TestClient without a context manager never runs the lifespan — pin the
    # state the route reads (same pattern as test_search_route).
    app.state.config = load_config(
        {"AI_SERVICE_TOKEN": "test-token-0123456789abcdef", "LLM_PROVIDER": "mock"}
    )
    app.state.gateway = Gateway.from_env({"LLM_PROVIDER": "mock"})
    return TestClient(app)


def test_ingest_success_returns_camel_case_report(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch, REPORT)
    res = client.post("/internal/v1/ingest", headers=AUTH)
    assert res.status_code == 200
    body = res.json()
    assert body["corpusDigest"] == "a" * 64
    assert body["embeddingModel"] == "mock-hashed-ngram-384"
    assert body["manualsTouched"] == 62
    assert body["chunks"] == {"new": 0, "changed": 0, "unchanged": 630, "removed": 0}
    assert body["durationMs"] == 643
    assert body["status"] == "completed"


def test_concurrent_run_is_409_ingest_in_progress_problem(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(monkeypatch, IngestInProgressError("another ingest run is in progress"))
    res = client.post("/internal/v1/ingest", headers=AUTH)
    assert res.status_code == 409
    body = res.json()
    # RFC-7807 problem shape with the shared code (api-contracts.md §2) —
    # NOT FastAPI's bare {"detail": "..."} (the app maps on `code`).
    assert body["code"] == "INGEST_IN_PROGRESS"
    assert body["status"] == 409
    assert "in progress" in body["detail"]


def test_ingest_requires_service_token(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(monkeypatch, REPORT)
    res = client.post("/internal/v1/ingest")
    assert res.status_code in (401, 403)
