"""Test bootstrap: env for the service under test."""

from __future__ import annotations

import os

os.environ.setdefault("AI_SERVICE_TOKEN", "test-token-0123456789abcdef")
os.environ.setdefault("LLM_PROVIDER", "mock")
os.environ.setdefault(
    "DATABASE_URL", "postgresql://turnaround:turnaround@localhost:5433/mro_copilot"
)
