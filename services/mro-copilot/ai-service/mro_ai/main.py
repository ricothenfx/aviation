"""FastAPI application (ADR-0012): health, readiness, metrics, internal embed.

Loopback/service-network only — the compose file publishes 4103 on 127.0.0.1
and the Next.js app calls it with the shared bearer token.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from prometheus_client import make_asgi_app
from pydantic import ValidationError

from mro_ai.config import Config, load_config
from mro_ai.db import check_pgvector, check_postgres
from mro_ai.gateway import Gateway, ProviderUnavailableError
from mro_ai.ingest import IngestInProgressError
from mro_ai.internal import schemas
from mro_ai.internal.routes import router as internal_router
from mro_ai.retrieval import RetrievalService
from mro_ai.rul import (
    InsufficientHistoryError,
    ModelNotLoadedError,
    ModelRegistry,
    RulService,
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Tests may pre-inject config/gateway via create_app — never overwrite.
    if not hasattr(app.state, "config"):
        app.state.config = load_config()
    if not hasattr(app.state, "gateway"):
        try:
            app.state.gateway = Gateway.from_env()
        except ProviderUnavailableError:
            # Start degraded: embeds fail until a provider is configured.
            # /readyz reports provider: "down" honestly (architecture.md §6).
            app.state.gateway = None
    if not hasattr(app.state, "retrieval"):
        config: Config = app.state.config
        gateway: Gateway | None = getattr(app.state, "gateway", None)
        # Degraded start (gateway None) still serves lexical-only search
        # (architecture.md §4 degradation ladder).
        app.state.retrieval = RetrievalService(config.database_url, gateway)
    if not hasattr(app.state, "rul_registry"):
        # F4 (ADR-0011): versioned artifact + hash verification at load time.
        # The artifact ships committed; /readyz reports its real state and a
        # missing/mismatched artifact fails the RUL dependency.
        app.state.rul_registry = ModelRegistry()
    if not hasattr(app.state, "rul"):
        app.state.rul = RulService(app.state.rul_registry, app.state.config.database_url)
    yield


def problem(request: Request, status: int, code: str, detail: str) -> JSONResponse:
    """RFC-7807-style error shape (api-contracts.md §3)."""
    request_id = request.headers.get("x-request-id", "req_unknown")
    return JSONResponse(
        status_code=status,
        content={
            "title": code.replace("_", " ").title(),
            "status": status,
            "code": code,
            "detail": detail,
            "requestId": request_id,
        },
    )


def create_app(config: Config | None = None, gateway: Gateway | None = None) -> FastAPI:
    app = FastAPI(title="mro-copilot ai-service", version="0.1.0", lifespan=lifespan)
    if config is not None:
        app.state.config = config
    if gateway is not None:
        app.state.gateway = gateway
    if config is not None and not hasattr(app.state, "rul_registry"):
        # RUL construction is cheap (the artifact loads lazily on first use),
        # so build it eagerly whenever config is known — keeps /readyz honest
        # even when tests bypass the lifespan.
        app.state.rul_registry = ModelRegistry()
        app.state.rul = RulService(app.state.rul_registry, config.database_url)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        """Liveness — no dependency checks (architecture.md §7)."""
        return {"status": "ok"}

    @app.get("/readyz")
    async def readyz(request: Request) -> JSONResponse:
        """Readiness — DB, pgvector, RUL artifact, provider (DoD F1/F4).

        F4 tightens the model gate: with predictions live, a missing or
        hash-mismatched artifact fails the RUL dependency (`model: down`,
        status degraded 503) — no predictions are served without provenance
        (architecture.md §6).
        """
        cfg: Config = request.app.state.config
        database_url = cfg.database_url
        postgres = check_postgres(database_url)
        pgvector = check_pgvector(database_url)
        gateway_state = getattr(request.app.state, "gateway", None)
        provider: schemas.DependencyState = "up" if gateway_state else "down"
        registry: ModelRegistry | None = getattr(request.app.state, "rul_registry", None)
        if registry is not None and registry.is_loaded():
            model: schemas.DependencyState = "up"
        else:
            model = "not_loaded"
        dependencies = schemas.DependencyReport(
            postgres="up" if postgres else "down",
            pgvector="up" if pgvector else "down",
            model=model,
            provider=provider,
        )
        ready = postgres and pgvector and provider == "up" and model == "up"
        body = schemas.ReadyResponse(
            status="ready" if ready else "degraded", dependencies=dependencies
        )
        return JSONResponse(status_code=200 if ready else 503, content=body.model_dump())

    app.include_router(internal_router)

    # Prometheus exposition (architecture.md §7).
    app.mount("/metrics", make_asgi_app())

    @app.exception_handler(ValidationError)
    async def validation_error_handler(request: Request, exc: ValidationError) -> JSONResponse:
        return problem(request, 500, "VALIDATION_ERROR", str(exc))

    @app.exception_handler(ProviderUnavailableError)
    async def provider_unavailable_handler(
        request: Request, exc: ProviderUnavailableError
    ) -> JSONResponse:
        return problem(request, 503, "PROVIDER_UNAVAILABLE", str(exc))

    @app.exception_handler(ModelNotLoadedError)
    async def model_not_loaded_handler(request: Request, exc: ModelNotLoadedError) -> JSONResponse:
        """503 MODEL_NOT_LOADED (api-contracts.md §2 mro additions)."""
        return problem(request, 503, "MODEL_NOT_LOADED", str(exc))

    @app.exception_handler(InsufficientHistoryError)
    async def insufficient_history_handler(
        request: Request, exc: InsufficientHistoryError
    ) -> JSONResponse:
        """422 INSUFFICIENT_HISTORY — the app renders latestRul: null ("—")."""
        return problem(request, 422, "INSUFFICIENT_HISTORY", str(exc))

    @app.exception_handler(IngestInProgressError)
    async def ingest_in_progress_handler(
        request: Request, exc: IngestInProgressError
    ) -> JSONResponse:
        """409 INGEST_IN_PROGRESS (api-contracts.md §1 Admin/Ingest)."""
        return problem(request, 409, "INGEST_IN_PROGRESS", str(exc))

    return app


app = create_app()
