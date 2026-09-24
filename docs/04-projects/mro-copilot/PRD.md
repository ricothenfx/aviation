# MRO Copilot — PRD

| Field | Value |
|---|---|
| Status | Approved — build target F1–F5 (user approval 2026-09-24, window open per D-02 after turnaround-iq F5) |
| Version | 1.0 (2026-09-24) |
| One-liner | Maintenance-manual RAG copilot with page-level citations, refuse-when-ungrounded guardrails, and human-in-the-loop answer sign-off — plus an engine-health (RUL) dashboard powered by the public NASA C-MAPSS dataset. |
| Primary targets | SIAEC, ST Engineering ("Engineer, AI & Digitalisation"), Rolls-Royce/GE/P&W digital teams, SIA Senior Data Scientist (Advanced AI), CAG ML Engineer (Req 7167) + CAG Full Stack (Req 7133) GenAI rows |
| Datasets | NASA C-MAPSS (public, cited: Saxena & Goebel 2008) · hand-written synthetic manual excerpts, fictional aircraft type **NX-320** — all visibly labeled simulated (D-07) |
| New decisions | ADR-0010 (pgvector, D-16) · ADR-0011 (RUL model, D-17) · ADR-0012 (AI topology, D-18) |

## 1. Problem Statement

MRO engineers work across massive technical documentation — an AMM alone exceeds 10k pages
per aircraft type, plus IPC, TSM, and a stream of Service Bulletins. Finding the right
procedure under AOG pressure (US$10k–150k per hour) means:

1. **Retrieval is manual and brittle.** Keyword search across siloed documents misses
   paraphrased queries ("no airflow after start" vs. the manual's "low bleed pressure"),
   and results carry no guarantee the passage still applies at the aircraft's revision.
2. **Ungrounded answers are dangerous.** A generic LLM that "helpfully" invents a torque
   value or step sequence is worse than no assistant; maintenance data must be cited,
   revision-traceable, and verified by a human before it is trusted.
3. **Removal planning is reactive.** Engine health signals that could predict removals sit
   in trend files disconnected from the engineer's workflow, so maintenance windows are
   missed until the engine tells you the hard way.

## 2. Users & Jobs-to-be-Done

| User | Job-to-be-done |
|---|---|
| **MRO maintenance engineer** (primary) | "When I'm staring at a fault, give me the applicable procedure *with the exact document, section, and revision* — in seconds, and tell me honestly when the corpus doesn't cover it." |
| **MRO reviewer / senior engineer** | "Nothing unverified reaches the floor. Let me sign off (or reject) drafted answers and see who decided what, when." |
| **Reliability engineer** | "Show me which engines are trending toward a removal inside the planned maintenance window — before it becomes an AOG." |
| **Interviewer (demo persona)** | See grounded AI with guardrails, eval evidence, and production-grade engineering — in under 10 minutes. |

## 3. User Stories

**Maintenance engineer**
- US-1: As an engineer, I can browse the NX-320 manual library by type and ATA chapter and read any task card with its revision metadata, so I trust what I read.
- US-2: As an engineer, I can search the corpus in plain language and get the matching sections with highlighted snippets and filters (doc type, ATA chapter), even when my wording differs from the manual's.
- US-3: As an engineer, I can ask a maintenance question in natural language and get a short, procedural answer where **every claim carries a citation** to a manual chunk.
- US-4: As an engineer, when the corpus cannot ground an answer, the copilot **refuses explicitly** instead of guessing, and points me to search instead.
- US-5: As an engineer, I can always see whether an answer was produced by the configured LLM or fell back to extractive mode, so I know what I am reading.

**Reviewer**
- US-6: As a reviewer, I can review drafted answers with their citations side-by-side and approve or reject them with a note; approved answers enter a verified library.
- US-7: As a reviewer, I can see the eval history (golden Q&A, refusal set, retrieval metrics) so "the copilot is safe" is a number I can read, not a claim.

**Reliability engineer**
- US-8: As a reliability engineer, I can see each engine's predicted RUL with trend and uncertainty, and get an alert when a unit is projected to cross its maintenance-window threshold.
- US-9: As a reliability engineer, I can acknowledge alerts and see exactly which model version produced a prediction.

**Reviewer/admin**
- US-10: As a reviewer, I can trigger corpus re-ingestion and see ingest status (chunk counts, model/embedding versions), and re-ingesting the same corpus changes nothing (idempotent).

## 4. In-Scope Features

| ID | Feature | Acceptance highlights |
|---|---|---|
| F-1 | **Manual library & browser** — synthetic NX-320 corpus (AMM task cards, IPC, TSM, SBs) with ATA-chapter structure, TOC navigation, revision metadata, persistent simulated-data labeling | Every content view traces to doc + section + page + revision; corpus committed in-repo as authored Markdown |
| F-2 | **Hybrid search** — pgvector semantic + PostgreSQL lexical (tsvector) fused by RRF (ADR-0010), filters doc type/ATA chapter/revision | Golden retrieval set recall@5 ≥ 0.85; p95 < 300 ms at reference scale |
| F-3 | **RAG copilot Q&A** — grounded answers with chunk-level citations, refuse-when-ungrounded, `source: llm \| extractive` labeling with provider disclosure (ADR-0003/0012) | Citation validity 100%; refusal accuracy 100% on refusal set; mock provider default, offline-safe |
| F-4 | **Answer sign-off (human-in-the-loop)** — draft → approve/reject by reviewer with note; append-only audit; verified-answer library | Engineers cannot approve (RBAC + separation of duties); full lifecycle replayable from audit events |
| F-5 | **Engine health (RUL)** — C-MAPSS-trained gradient-boosted RUL model (ADR-0011) served by ai-service; fleet tiles, per-unit trend + uncertainty band, maintenance-window alerts with ack lifecycle | Training reproducible from committed seeded script (artifact hash); FD001 test RMSE ≤ 24 cycles reported next to published baselines; alerts fire ≥ 5 cycles before threshold in fixtures |
| F-6 | **Eval harness & eval dashboard** — golden QA (≥ 50) + refusal (≥ 20) sets as versioned fixtures; offline CI-gated eval runs; committed reports; read-only run history for reviewers | Gates: recall@5 ≥ 0.85, refusal 100%, citation validity 100%, grounded answer rate ≥ 80%; bad results reported alongside good (D-07) |
| F-7 | **RBAC + auth** — seeded users; roles: `viewer` (read corpus + health), `engineer` (ask, draft answers, ack alerts), `reviewer` (sign-off, eval history, re-ingest) | Unauthorized actions blocked server-side; Cognito-shaped provider per D-09 |

## 5. Functional Requirements

**Auth & platform**
- FR-1: Seeded users with role ladder `viewer < engineer < reviewer`; JWT session cookie; per-endpoint server-side authorization; no self-registration.
- FR-2: Every mutating endpoint accepts `Idempotency-Key` and is safe on retry (engineering-standards.md §4).
- FR-3: Every screen shows the persistent "Simulated data for portfolio purposes" footer (data-ethics.md §2); C-MAPSS views additionally cite the dataset.

**Corpus & ingestion**
- FR-4: Corpus is hand-written Markdown, fictionally branded NX-320, in four doc types (`AMM`, `IPC`, `TSM`, `SB`) with ATA-chapter numbering, task numbers, page markers, and revision/effective metadata (data-model.md §4).
- FR-5: Ingestion CLI (`python -m mro_ai.ingest`, inside ai-service, ADR-0012) parses → chunks (data-model.md §5 strategy) → embeds → upserts to pgvector; idempotent by chunk content hash: re-ingesting an unchanged corpus yields byte-identical chunk set and vector count.
- FR-6: Every chunk retains provenance: doc id, doc type, task/section path, page, revision; deletion of a superseded revision is explicit, never silent.

**Search**
- FR-7: `GET /api/v1/search` executes hybrid retrieval (vector cosine top-k + tsvector lexical ranking, RRF fusion) with optional filters; response carries per-chunk score and highlighted snippet.
- FR-8: Search p95 < 300 ms at reference scale (~900 chunks) on the compose stack.

**Copilot Q&A**
- FR-9: `POST /api/v1/ask` runs: retrieval → prompt assembly (TS app, ADR-0012) → `packages/llm-gateway.complete` → guardrail validation → persisted answer (`status: draft`) with citations and grounding score.
- FR-10: Refusal-when-ungrounded: if the top retrieval score is below the configured threshold or no citation passes validity, the copilot returns an explicit refusal (`status: refused`, machine-readable reason) and never emits procedural content without citations.
- FR-11: Citation validity invariant: every citation resolves to a chunk actually retrieved for that answer — enforced in code, asserted at 100% by eval.
- FR-12: Source honesty: payload carries `source: "llm" | "extractive"` and `provider` (e.g. `mock`); extractive fallback returns top chunks verbatim when no LLM is available; the UI renders a badge for both (ADR-0003, ADR-0012).
- FR-13: Ask p95 < 2.5 s with the mock provider on the compose stack; each ask is single-turn (no chat memory — OUT scope).

**Sign-off**
- FR-14: Answer lifecycle `draft → approved | rejected`, transitions by `reviewer` only, with mandatory note on reject; an answer is never approved by its author (separation of duties); all transitions recorded as append-only audit events.
- FR-15: Approved answers form a searchable verified-answer library; a re-ask that matches an approved question surfaces it (labeled `verified`).

**Engine health**
- FR-16: RUL predictions come only from a versioned artifact (semver + sha256) loaded by ai-service; every response includes `modelVersion` and an uncertainty band; prediction without model provenance is a defect.
- FR-17: Fleet dashboard shows per-unit latest RUL, degradation trend chart (labeled axes/units, ui-design-system §8), and maintenance-window alerts (`raised → acknowledged → resolved`, ack by engineer+).
- FR-18: Alerts fire when projected RUL crosses the unit's maintenance-window threshold with ≥ 5 cycles lead in fixtures; alert + prediction history is queryable per unit.

**Evaluation**
- FR-19: Golden QA set (≥ 50 pairs: question, expected citations, answer sketch, tags) and refusal set (≥ 20 unanswerable/out-of-corpus questions) are committed, versioned fixtures (data-model.md §9).
- FR-20: Eval CLI runs the full pipeline offline (mock provider) and emits JSON + Markdown reports; CI fails below gates: recall@5 ≥ 0.85, refusal accuracy 100%, citation validity 100%, grounded answer rate ≥ 80%.
- FR-21: Eval run reports are persisted and visible read-only to `reviewer` in the eval dashboard.

## 6. OUT OF SCOPE (binding — do not build)

- **Real manuals or real aircraft types** — no Boeing/Airbus/ATR content, real ATA task numbers of real fleets, or real SBs; the corpus is 100% fictional NX-320, visibly labeled.
- **PDF/OCR/document-conversion pipelines** — the corpus is authored Markdown; processing real publisher formats is a documented limitation, not a hidden TODO.
- **LLM fine-tuning, self-hosted model serving, agent/tool-use loops** — retrieval is the only tool; Bedrock/AgentCore remain interface-shape mappings (tech-stack.md §2, ADR-0012).
- **Autonomous AI decisions** — the LLM never approves, signs off, or mutates maintenance records; humans sign off (PRD F-4).
- **Multi-turn chat with memory** — each ask is standalone and grounded; conversational threading is out of scope.
- **Realtime push (WebSocket), email/SNS notifications, mobile native apps** — polling refresh; tablet-width responsive is the bar.
- **Fleet-scale MRO systems**: multi-type libraries, tenancy, integration with real MRO IT (AMOS/TRAX-class), parts/logistics, work-order management.
- **MLOps platform depth** (MLflow-style experiment tracking, automated retraining pipelines, drift dashboards): versioned artifacts + committed seeded training + eval reports are the bar; more is documented future work.
- **i18n, billing, user registration flows** (seeded users only, per D-09 pattern).

## 7. Success Metrics (demo-verifiable)

| Metric | Target |
|---|---|
| Golden retrieval recall@5 (hybrid) | ≥ 0.85 |
| Refusal accuracy on refusal set | 100% (hard gate) |
| Citation validity (answers produced) | 100% (hard gate) |
| Grounded answer rate on golden QA | ≥ 80% |
| RUL FD001 test RMSE | ≤ 24 cycles, reported next to published GBM/LSTM baselines |
| Search p95 latency | < 300 ms (reference scale) |
| Ask p95 latency (mock provider) | < 2.5 s |
| Ingest idempotency | re-ingest unchanged corpus ⇒ identical chunk hashes + count |

## 8. Domain Primer (for agents new to MRO)

- **AMM** (Aircraft Maintenance Manual): step-structured procedure/task cards, ATA-chapter
  numbered (e.g. chapter 29 = hydraulic power). **IPC** (Illustrated Parts Catalogue):
  part numbers/figures. **TSM** (Troubleshooting Manual): fault → isolation procedure.
  **SB** (Service Bulletin): manufacturer-issued modification, with applicability and
  effective dates.
- **Revision**: manuals change continuously; an answer citing a superseded revision is a
  defect — hence revision metadata on every chunk (FR-6) and human sign-off (F-4).
- **AOG** (Aircraft On Ground): the emergency state that makes retrieval speed money.
- **RUL** (Remaining Useful Life): predicted cycles/flight-hours until maintenance-requiring
  degradation. **C-MAPSS**: NASA's public Commercial Modular Aero-Propulsion System
  Simulation dataset — 4 sub-datasets of turbofan run-to-failure trajectories with 21
  sensor channels; FD001 is the reference subset (one operating condition, one fault mode).
- **Maintenance window**: planned shop-visit opportunity; an alert's job is to surface a
  predicted removal *inside* the window rather than after an in-service event.

## 9. References

- Requirement source: `docs/00-context/target-roles.md` §2 (CAG Req 7133 GenAI rows: RAG,
  grounding, validation, guardrails, evaluation, human-in-the-loop; Req 7167 MLOps rows).
- Data rules: `docs/02-standards/data-ethics.md` (C-MAPSS citation; synthetic labeling).
- UI rules: `docs/02-standards/ui-design-system.md`. Platform: `docs/03-platform/tech-stack.md`.
- Decisions: D-16/ADR-0010 (pgvector hybrid retrieval), D-17/ADR-0011 (RUL model),
  D-18/ADR-0012 (AI topology, Python gateway port), ADR-0003 (LLM gateway), D-09 (auth).
- Companion docs: architecture.md · data-model.md · api-contracts.md · milestones.md.
