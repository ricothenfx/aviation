"""Unit tests for hybrid retrieval SQL construction (ADR-0010, §4)."""

from __future__ import annotations

from mro_ai.retrieval import (
    LEG_TOP_K,
    RRF_K,
    SearchFilters,
    build_search_sql,
    row_to_hit,
)


def test_hybrid_sql_has_both_legs_and_rrf_constant() -> None:
    statement, params = build_search_sql("low bleed pressure", [0.1] * 384, 8, None)
    assert "vec as" in statement
    assert "lex as" in statement
    assert "union all" in statement
    assert "ts_rank_cd" in statement
    assert "<=>" in statement
    assert params["rrf_k"] == RRF_K == 60
    assert params["leg_k"] == LEG_TOP_K == 20
    assert "m.status = 'active'" in statement  # default: active revisions only


def test_degraded_lexical_sql_skips_vector_leg() -> None:
    statement, params = build_search_sql("low bleed pressure", None, 8, None)
    assert "vec as" not in statement
    assert "lex as" in statement
    assert "embedding" not in statement
    assert "embedding" not in params


def test_filters_apply_to_both_legs() -> None:
    filters = SearchFilters(doc_types=["TSM", "AMM"], ata_chapters=["29"], revision="Rev 37")
    statement, params = build_search_sql("torque", [0.1] * 384, 8, filters)
    # both leg CTEs carry the same filter conjunction
    legs = statement.split("),")
    body_legs = [seg for seg in legs if "from chunks c" in seg]
    assert len(body_legs) == 2
    for seg in body_legs:
        assert "m.doc_type::text = any" in seg
        assert "m.ata_chapter = any" in seg
    assert "m.revision = %(revision)s" in statement
    assert "m.status = 'active'" not in statement  # explicit revision replaces default
    assert params["doc_types"] == ["TSM", "AMM"]
    assert params["ata_chapters"] == ["29"]
    assert params["revision"] == "Rev 37"


def test_snippet_highlights_use_safe_delimiters() -> None:
    statement, _params = build_search_sql("torque", [0.1] * 384, 8, None)
    assert "StartSel=[[" in statement
    assert "StopSel=]]" in statement


def test_row_to_hit_maps_sql_row() -> None:
    hit = row_to_hit(
        (
            "chunk-uuid",
            0.031,
            "manual-uuid",
            "TSM",
            "29-11-00-000-401",
            "29",
            "NX320 TSM · Task 29-11-00-000-401",
            12,
            "Rev 37",
            "2026-03-01",
            "content [[torque]] snippet",
            0.61,  # vector_score (F3 grounding signal)
            0.71,  # term_coverage (F3 grounding signal)
        )
    )
    assert hit.chunk_id == "chunk-uuid"
    assert hit.score == 0.031
    assert hit.doc_type == "TSM"
    assert hit.task_no == "29-11-00-000-401"
    assert hit.page == 12
    assert hit.revision == "Rev 37"
    assert hit.effective_date == "2026-03-01"
    assert hit.snippet == "content [[torque]] snippet"
    assert hit.vector_score == 0.61
    assert hit.term_coverage == 0.71


def test_row_to_hit_maps_null_vector_score_lexical_mode() -> None:
    hit = row_to_hit(
        (
            "chunk-uuid",
            0.031,
            "manual-uuid",
            "TSM",
            "29-11-00-000-401",
            "29",
            "NX320 TSM · Task 29-11-00-000-401",
            12,
            "Rev 37",
            "2026-03-01",
            "content snippet",
            None,  # lexical mode: no cosine available
            0.5,
        )
    )
    assert hit.vector_score is None
    assert hit.term_coverage == 0.5


def test_grounding_signal_columns_present_in_sql() -> None:
    statement, params = build_search_sql("torque", [0.1] * 384, 8, None)
    assert "vector_score" in statement
    assert "term_coverage" in statement
    lexical_statement, lexical_params = build_search_sql("torque", None, 8, None)
    assert "vector_score" in lexical_statement  # null::float8 in lexical mode
    assert "embedding" not in lexical_statement
    assert "embedding" not in lexical_params
    assert "term_coverage" in lexical_statement
