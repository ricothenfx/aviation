"""Unit tests for the corpus chunker (data-model.md §5, PRD FR-5/FR-6)."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest

from mro_ai.corpus import (
    HARD_CAP_TOKENS,
    TARGET_MAX_TOKENS,
    chunk_document,
    corpus_digest,
    estimate_tokens,
    ingest_plan,
    parse_document,
)

DOC = """---
doc_type: AMM
title: "hydraulic accumulator — replacement"
ata_chapter: 29
task_no: 29-11-00-000-401
revision: Rev 37
effective_date: 2026-03-01
---
# NX320 AMM · ATA 29 · 29-11-00 · Task 29-11-00-000-401 · hydraulic accumulator — replacement

## General

This task card covers the replacement of the hydraulic accumulator.
This card belongs to the simulated NX-320 training corpus.

## Safety

The following hazards apply:

- residual pressure in the manifold can inject fluid through the skin

## Procedure

### Removal

1. Depressurize the hydraulic circuit and verify zero pressure on the gauge.
   WARNING: residual pressure in the high-pressure manifold can inject fluid through the skin
2. Attach the applicable warning placards and open the access panel.
3. Support the accumulator with a suitable sling before loosening hardware.

### Installation

4. Position the accumulator on its mounts and hand-start all attach bolts.
5. Torque the accumulator attach bolts to 34.5 Nm in the crosswise sequence.
"""


@pytest.fixture()
def corpus(tmp_path: Path) -> Path:
    docs = tmp_path / "manuals"
    docs.mkdir()
    (docs / "amm-29-11.md").write_text(DOC, encoding="utf-8")
    return docs


def test_parse_extracts_front_matter_and_breadcrumb(corpus: Path) -> None:
    doc = parse_document(corpus / "amm-29-11.md", corpus)
    assert doc.meta.doc_type == "AMM"
    assert doc.meta.task_no == "29-11-00-000-401"
    assert doc.meta.revision == "Rev 37"
    assert doc.meta.breadcrumb == (
        "NX320 AMM · ATA 29 · 29-11-00 · Task 29-11-00-000-401"
        " · hydraulic accumulator — replacement"
    )


def test_chunks_start_with_canonical_heading_path(corpus: Path) -> None:
    doc = parse_document(corpus / "amm-29-11.md", corpus)
    chunks = chunk_document(doc)
    assert chunks
    for chunk in chunks:
        assert chunk.content.startswith(chunk.section_path)
        assert chunk.section_path.startswith(doc.meta.breadcrumb)


def test_warning_never_splits_from_parent_step(corpus: Path) -> None:
    doc = parse_document(corpus / "amm-29-11.md", corpus)
    chunks = chunk_document(doc)
    warning_text = "residual pressure in the high-pressure manifold"
    owner_step = "Depressurize the hydraulic circuit"
    found = [(warning_text in c.content and owner_step in c.content) for c in chunks]
    assert any(found), "warning and its parent step must share one chunk"


def test_page_marker_maps_to_chunk_page(corpus: Path) -> None:
    doc = parse_document(corpus / "amm-29-11.md", corpus)
    chunks = chunk_document(doc)
    assert all(c.page >= 1 for c in chunks)
    # later chunks must not regress to an earlier fictional page
    pages = [c.page for c in chunks]
    assert pages == sorted(pages)


def test_chunk_hash_is_sha256_of_stable_fields(corpus: Path) -> None:
    doc = parse_document(corpus / "amm-29-11.md", corpus)
    chunk = chunk_document(doc)[0]
    payload = f"{chunk.manual_id}|{chunk.section_path}|{chunk.chunk_index}|{chunk.content}"
    assert chunk.chunk_hash == hashlib.sha256(payload.encode("utf-8")).hexdigest()


def test_ingest_plan_is_deterministic(corpus: Path) -> None:
    first = ingest_plan(corpus)
    second = ingest_plan(corpus)
    hashes_first = [c.chunk_hash for _m, cs in first for c in cs]
    hashes_second = [c.chunk_hash for _m, cs in second for c in cs]
    assert hashes_first == hashes_second
    assert corpus_digest([c for _m, cs in first for c in cs]) == corpus_digest(
        [c for _m, cs in second for c in cs]
    )


def test_sizing_band_holds_on_real_corpus_layout() -> None:
    """Sizing rules (target 200-450, hard cap 500) hold on the committed corpus."""
    env_dir = os.environ.get("MRO_CORPUS_DIR")
    if env_dir:
        corpus_root: Path | None = Path(env_dir)
    else:
        # repo layout: tests → ai-service → mro-copilot → services → repo root
        parents = Path(__file__).resolve().parents
        corpus_root = (
            parents[4] / "apps" / "mro-copilot" / "seed" / "manuals" if len(parents) > 4 else None
        )
    if corpus_root is None or not corpus_root.exists():
        pytest.skip("committed corpus not present (containerized thin checkout)")
    plan = ingest_plan(corpus_root)
    assert len(plan) >= 40, "PRD FR-4: ≥ 40 docs"
    chunks = [c for _m, cs in plan for c in cs]
    assert len(chunks) >= 600, "data-model.md §6: ≥ 600 chunks at reference scale"
    assert all(c.token_count <= HARD_CAP_TOKENS for c in chunks)
    in_band = sum(1 for c in chunks if c.token_count <= TARGET_MAX_TOKENS)
    assert in_band / len(chunks) > 0.95
    # every chunk resolves to doc + section + fictional page + revision (DoD)
    for meta, cs in plan:
        assert meta.title and meta.revision and meta.ata_chapter
        for chunk in cs:
            assert chunk.page >= 1 and chunk.token_count >= 1


def test_estimate_tokens_matches_gateway_heuristic() -> None:
    assert estimate_tokens("") == 1
    assert estimate_tokens("abcd") == 1
    assert estimate_tokens("abcdefgh") == 2
