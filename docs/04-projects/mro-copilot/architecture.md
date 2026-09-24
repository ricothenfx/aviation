# MRO Copilot — Architecture

| Field | Value |
|---|---|
| Status | Approved (user approval 2026-09-24) |
| Decisions applied | ADR-0003 (LLM gateway), ADR-0010 (pgvector hybrid retrieval, D-16), ADR-0011 (RUL model, D-17), ADR-0012 (AI topology, D-18), D-09 (auth) |

## 1. System Overview

```mermaid
flowchart LR
    subgraph Client
        UI[Next.js App\nManual browser · Search · Ask panel\nReview queue · Eval dashboard · Engine health]
    end
    subgraph App["apps/mro-copilot (TS)"]
        API[REST /api/v1\nauth · RBAC · audit · idempotency]
        RAG[RAG orchestrator\nprompt assembly · guardrails\ncitation validation · sign-off state machine]
        ALERTS[Alert engine\nmaintenance-window rules]
    end
    subgraph AI["services/mro-copilot/ai-service (Python, internal-only)"]
        GW[Gateway port\nADR-0003 shape: complete/embed\nmock · openai-compat · bedrock-shape]
        RET[Retrieval\npgvector cosine + tsvector lexical → RRF]
        RUL[RUL predictor\nversioned GBM artifact, ADR-0011]
        CLI[CLI modules\ningest · train · eval-support]
    end
    subgraph Data
        PG[(PostgreSQL 16 + pgvector + TimescaleDB\nchunks · embeddings · answers · audit\nsensor_readings hypertable · engine units)]
    end
    LLM[[LLM provider\n(off by default: mock)]]

    UI -->|REST| API --> RAG
    API --> ALERTS
    RAG -->|/internal/v1/retrieval/search| RET
    RAG -->|complete\(\) via packages/llm-gateway| LLM
    ALERTS -->|/internal/v1/rul/score-fleet| RUL
    CLI --> GW
    CLI --> PG
    RET --> PG
    RUL --> PG
    GW --> LLM
```

Two runtimes, one product: **product logic is TypeScript** (PRD domain, sign-off,
guardrails), **AI serving is Python** (embeddings, retrieval SQL, model inference) — the
D-03 / tech-stack.md split, made concrete by ADR-0012. No Redis, no ws: mro-copilot has
no realtime projection layer; screens poll and every latency budget (PRD §7) leaves
headroom for it.

## 2. Component Responsibilities

| Component | Owns | Must NOT |
|---|---|---|
| `apps/mro-copilot` (Next.js) | UI (6 screens), REST `/api/v1`, session auth + RBAC, **RAG orchestration**: prompt assembly, guardrail checks, citation-validity enforcement, refusal decision, answer lifecycle + audit, alert rules, verified-answer library | embed text or run models (Python's job); talk to LLM vendors outside `packages/llm-gateway` (tech-stack.md §3); read model artifacts |
| `services/mro-copilot/ai-service` (FastAPI) | gateway port (ADR-0003 shape), query/chunk embeddings, hybrid retrieval SQL (ADR-0010), RUL feature engineering + inference (ADR-0011), ingest/train CLIs; read-only DB access at request time | contain product domain logic (sign-off, RBAC); be exposed publicly (loopback/service-network only); write answers or audit records |
| `packages/llm-gateway` (existing, TS) | provider-agnostic `complete` for answer synthesis; mock provider default | gain retrieval/model-serving concerns (ADR-0012 keeps it narrow) |
| `packages/contracts` | zod schemas for REST payloads + error envelope | know about mro domain semantics beyond shared envelopes |

Auth module (D-09 pattern: seeded users, argon2id, JWT cookie, `AuthProvider`
Cognito-shaped interface) is re-implemented inside `apps/mro-copilot` — D-08 forbids
cross-project imports; duplication is deliberate and interface-tested.

## 3. Request Flows

**Ingest (offline, idempotent)** — reviewer triggers `POST /api/v1/admin/ingest` (or CI):
1. CLI walks `apps/mro-copilot/seed/manuals/**.md`, chunks per data-model.md §5,
   computes sha256 per chunk.
2. Embeds new/changed chunks via gateway port (mock by default — deterministic).
3. Single transaction: upsert chunks + embeddings + FTS column, mark superseded revisions;
   emits ingest report (counts, hashes, embedding model id). Re-run on unchanged corpus
   = no-op (PRD FR-5).

**Ask (the RAG loop)**:
1. `POST /api/v1/ask {question}` → RBAC `engineer+`, `Idempotency-Key` accepted.
2. App → ai-service `/internal/v1/retrieval/search` (top-k=8, RRF hybrid). Response names
   its mode: `hybrid` or degraded `lexical` (embedding provider down).
3. App guardrail pre-check: if top fused score < `GROUNDING_MIN_SCORE` (config, default
   from eval calibration) → **refuse without calling the LLM** (`status: refused`, reason
   `below_grounding_threshold`), persist refusal + audit event.
4. Else: prompt = system guard (answer only from context, cite per claim, say
   "not covered by the provided documents" otherwise) + numbered context chunks +
   question → `packages/llm-gateway.complete`.
5. Post-check: every citation LLM output references must exist in the retrieved set and
   every claim-citation survives validation; invalid citation → strip + re-check, empty
   valid set → downgrade to refusal (never emit uncited procedural content, FR-10/11).
6. Persist answer (`draft`) + citations + `{source, provider}` + latency/token metrics;
   respond. p95 budget 2.5 s (PRD FR-13).

**Sign-off**: reviewer `approve|reject` (note mandatory on reject) → append-only audit
events; approved answers feed the verified-answer library surfaced on matching re-asks.

**Engine health**: seed downloads C-MAPSS (pinned URL + sha256) into `sensor_readings`
(TimescaleDB hypertable) → `train` CLI builds the versioned artifact + `metrics.json`
(committed) → `POST /api/v1/engines/score-fleet` has the app ask ai-service to score
units → app's alert engine compares projected RUL against each unit's maintenance-window
threshold → alert lifecycle events → dashboard.

## 4. Retrieval Design (ADR-0010)

- Hybrid: `pgvector` HNSW cosine top-20 (384-dim) fused with `tsvector` GIN lexical
  top-20 via **reciprocal rank fusion** (k=60), cut to top-8 for prompting. SQL lives in
  ai-service; single round-trip.
- Filters (doc type, ATA chapter, revision applicability) apply to both legs before fusion.
- Degradation ladder: hybrid → lexical-only (embedding provider unavailable; response and
  UI flag the mode) → search unavailable (DB down; error state).
- Why not a vector DB: corpus ≈ 600–900 chunks; single-engine consistency, transactional
  re-ingest and metadata filtering beat an extra service at this scale (ADR-0010).
- Honest limit: the mock embedder (hashed character n-grams) is semantically weak; the
  hybrid leg exists partly to keep offline quality acceptable, and eval gates recall@5
  rather than asserting excellence (data-ethics.md §4).

## 5. AuthN / AuthZ (D-09)

- Seeded users, argon2id hashes, httpOnly JWT session cookie (SameSite=Lax).
- Role ladder: `viewer` (browse, search, read health) < `engineer` (ask, draft answers,
  ack alerts) < `reviewer` (approve/reject, eval history, trigger ingest).
- Enforcement server-side per handler; middleware guards routes only. Separation of
  duties: an engineer can never approve their own draft even if escalated later —
  approval requires a distinct reviewer principal (tested).
- ai-service auth: shared-secret bearer (`AI_SERVICE_TOKEN`), service-network only, never
  published beyond loopback in compose (ADR-0012).

## 6. Failure Handling

| Failure | Behavior |
|---|---|
| ai-service down | search/ask render error state with retry; engine-health shows stale-data badge + error; ingest refuses to start |
| LLM provider unavailable/error | extractive fallback (top chunks verbatim), `source: "extractive"` (ADR-0003 degrade path) |
| Embedding provider unavailable at query time | retrieval degrades to lexical-only, mode flagged in response + UI |
| Embedding provider unavailable at ingest | ingest fails loudly pre-write (no half-embedded corpus) |
| Model artifact missing/hash mismatch | `/readyz` fails RUL dependency; health UI shows explicit "model not loaded" state; no predictions served |
| pgvector extension absent | boot-time migration failure (loud), documented remediation |
| LLM emits hallucinated citation | post-check strips it; if no valid citations remain → refusal (never uncited content) |
| Duplicate mutating request | `Idempotency-Key` replay returns original result |

## 7. Observability (F5 evidence)

- pino JSON logs (app) + structlog-style JSON (ai-service); `requestId` propagated to
  ai-service via header; one log line per RAG stage with stage timings.
- Metrics (Prometheus format, ai-service `/metrics` + app): `ask_latency`,
  `retrieval_latency`, `retrieval_mode_total{mode}`, `refusals_total{reason}`,
  `citation_validity_ratio`, `llm_token_usage`, `rul_predict_latency`, `ingest_chunks_total`.
- Eval reports double as quality observability: every run's recall/grounding/refusal
  numbers persisted and reviewable (PRD F-6).
- `/healthz` + `/readyz` on both services (readyz checks: DB, pgvector, artifact, provider).

## 8. Deployment Shape

- Local: compose profile `mro` — web :3003, ai-service :4103 (loopback), shared `infra`
  Postgres (database `mro_copilot`); no Redis container for this project.
- Public demo (F5): mirrors D-12 topology (single VPS behind Caddy, prod images,
  loopback-only data services); ai-service stays internal behind the web container.
- AWS mapping: web → Amplify/ECS Fargate; ai-service → ECS Fargate calling **Bedrock**
  (Converse API) via the gateway port; pgvector → RDS PostgreSQL; corpus/model artifacts →
  S3; auth → Cognito (tech-stack.md §2 — interview narrative + IaC-ready structure, same
  as turnaround-iq F5 precedent).
