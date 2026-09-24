"""Pydantic side of the cross-language contract check (DoD F1).

Parses the SAME committed fixture as the zod test in
apps/mro-copilot/src/lib/ai/contract.test.ts and asserts the wire field names
(camelCase aliases) match the fixture's declared field lists.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from mro_ai.gateway.mock import EMBED_DIMENSIONS, EMBED_MODEL_ID
from mro_ai.internal.schemas import EmbedRequest, EmbedResponse, TokenUsage

FIXTURE = Path(__file__).parent / "fixtures" / "embed_contract.json"


def load_fixture() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_request_parses_and_fields_match_fixture() -> None:
    fixture = load_fixture()
    model = EmbedRequest.model_validate(fixture["request"])
    assert list(EmbedRequest.model_fields.keys()) == fixture["requestFields"]
    assert model.texts == fixture["request"]["texts"]


def test_response_parses_and_wire_fields_match_fixture() -> None:
    fixture = load_fixture()
    raw = fixture["response"]
    # The committed example vector is the embedder's real output for the
    # fixture text — exactly 384 dims.
    assert len(raw["vectors"][0]) == fixture["vectorDimensions"] == EMBED_DIMENSIONS

    model = EmbedResponse.model_validate(raw)
    dumped = model.model_dump(by_alias=True)
    assert list(dumped.keys()) == fixture["responseFields"]
    assert list(dumped["usage"].keys()) == fixture["usageFields"]
    assert dumped["model"] == EMBED_MODEL_ID


def test_response_rejects_wrong_vector_dimension() -> None:
    fixture = load_fixture()
    bad = {
        "model": fixture["response"]["model"],
        "vectors": [[0.0] * (EMBED_DIMENSIONS - 1)],
        "usage": {"inputTokens": 1},
    }
    with pytest.raises(ValidationError):
        EmbedResponse.model_validate(bad)


def test_usage_alias_is_camel_case_on_the_wire() -> None:
    usage = TokenUsage.model_validate({"inputTokens": 5})
    assert usage.input_tokens == 5
    assert usage.model_dump(by_alias=True) == {"inputTokens": 5}


def test_embedder_output_is_finite_and_normalized_for_fixture_text() -> None:
    fixture = load_fixture()
    vector = fixture["response"]["vectors"][0]
    assert all(math.isfinite(v) for v in vector)
    assert math.isclose(math.sqrt(sum(v * v for v in vector)), 1.0, abs_tol=1e-9)
