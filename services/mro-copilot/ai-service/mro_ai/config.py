"""Service configuration (engineering-standards.md §7: no secrets in code)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

DEFAULT_DATABASE_URL = "postgresql://turnaround:turnaround@localhost:5433/mro_copilot"

ProviderName = Literal["mock", "openai-compatible", "bedrock-shape"]


@dataclass(frozen=True)
class Config:
    database_url: str
    ai_service_token: str | None
    provider: Literal["mock", "openai-compatible", "bedrock-shape", "off"]


def load_config(env: dict[str, str] | None = None) -> Config:
    """Read config from env (or an injected dict for tests)."""
    source = env if env is not None else os.environ
    provider = source.get("LLM_PROVIDER", "mock")
    if provider not in ("mock", "openai-compatible", "bedrock-shape", "off"):
        raise ValueError(f"unsupported LLM_PROVIDER: {provider}")
    return Config(
        database_url=source.get("DATABASE_URL", DEFAULT_DATABASE_URL),
        ai_service_token=source.get("AI_SERVICE_TOKEN"),
        provider=provider,  # type: ignore[arg-type]
    )
