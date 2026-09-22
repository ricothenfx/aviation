# MRO Copilot — PRD (Skeleton)

| Field | Value |
|---|---|
| Status | **Spec pending** — full specification happens when its build window opens (D-02). Do not implement from this skeleton. |
| One-liner | Maintenance-manual RAG copilot with citations, guardrails, and human-in-the-loop sign-off — plus an engine-health (RUL) dashboard powered by the public NASA C-MAPSS dataset. |

## Problem (draft)
MRO engineers work across massive manuals (AMM > 10k pages per type) plus IPC/TSM/SBs;
finding a procedure takes hours, and an AOG costs US$10k–150k per hour. Meanwhile sensor
data that could predict removals sits disconnected from the engineer's workflow.

## Solution (draft)
1. **RAG copilot** — natural-language Q&A over manuals with page-level citations, refuse-when-ungrounded behavior, answer sign-off workflow (human-in-the-loop), eval harness with golden Q&A set (grounding, validation, guardrails, observability — mirroring CAG Req 7133/7167 vocabulary).
2. **Engine health** — ingest NASA C-MAPSS turbofan data → RUL prediction model → health dashboard with maintenance-window alerts.

## Planned stack deltas (from locked platform)
- Python FastAPI service for model + retrieval serving (D-03); pgvector in the existing PostgreSQL cluster; `packages/llm-gateway` (ADR-0003).

## Primary targets
SIAEC, ST Engineering ("Engineer, AI & Digitalisation"), Rolls-Royce/GE/P&W digital teams,
SIA Senior Data Scientist (Advanced AI), CAG ML Engineer (Req 7167).

## Datasets
NASA C-MAPSS (public, cited) · hand-written synthetic manual excerpts (fictional aircraft type "NX-320").

## TODO at spec time
Full PRD (user stories, OUT OF SCOPE), architecture, data model (chunking strategy, eval sets), API contracts, milestones F1–F5, demo script.
