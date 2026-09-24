# MRO Copilot — API Contracts

| Field | Value |
|---|---|
| Status | Approved (user approval 2026-09-24) — schemas live in `packages/contracts` (zod) + ai-service pydantic models |
| Conventions | REST prefix `/api/v1` · cursor pagination · standard error envelope · `Idempotency-Key` on mutations (engineering-standards.md §4) · additive changes only — breaking = new versioned route/type, never in-place mutation |

## 1. REST Endpoints (app, `apps/mro-copilot`)

### Auth
| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| POST | `/api/v1/auth/login` | — | `{email, password}` | `{user, token}` · httpOnly session cookie (D-09 pattern) |
| POST | `/api/v1/auth/logout` | any | — | 204 |
| GET | `/api/v1/auth/me` | viewer+ | — | `{user: {id, email, role}}` |

### Manuals & Search
| Method | Path | Role | Query | Response |
|---|---|---|---|---|
| GET | `/api/v1/manuals` | viewer+ | `docType`, `ataChapter`, `status`, `cursor` | manuals + TOC summary |
| GET | `/api/v1/manuals/{id}` | viewer+ | — | metadata + full section tree |
| GET | `/api/v1/manuals/{id}/chunks/{chunkId}` | viewer+ | — | chunk: breadcrumb, content, page, revision, effective date |
| GET | `/api/v1/search` | viewer+ | `q` (required), `docType`, `ataChapter`, `revision`, `limit` ≤ 20 | `{mode: "hybrid"\|"lexical", results: [SearchHit]}` — `SearchHit = {chunkId, manualId, docType, taskNo, ataChapter, sectionPath, page, revision, snippet, score}`; `mode` flags degraded retrieval (architecture.md §4) |

### Copilot Q&A (PRD F-3/F-4)
| Method | Path | Role | Body | Notes |
|---|---|---|---|---|
| POST | `/api/v1/ask` | engineer+ | `{question}` | RAG loop (architecture.md §3). 200 either way: `{answerId, status: "draft"\|"refused", answer?, citations?, refusalReason?, source: "llm"\|"extractive", provider, groundingScore, retrieval: {mode, latencyMs}}`. Refusal is a valid outcome, not an error (FR-10) |
| GET | `/api/v1/answers` | viewer+ | `status`, `cursor` | viewer sees approved (verified library) only; engineer adds own drafts; reviewer sees all |
| GET | `/api/v1/answers/{id}` | owner / viewer+ if approved | — | detail + citations + review block |
| GET | `/api/v1/answers/{id}/audit` | reviewer+ (or owner) | — | append-only lifecycle events |
| GET | `/api/v1/reviews/queue` | reviewer+ | pending drafts (cursor-paginated) |
| POST | `/api/v1/answers/{id}/approve` | reviewer+ | — | `draft → approved`; **cannot be the answer's author** (separation of duties, FR-14) |
| POST | `/api/v1/answers/{id}/reject` | reviewer+ | `{note}` (mandatory) | `draft → rejected`; audit-recorded |

`Citation = {chunkId, manualId, docType, ataChapter, taskNo, sectionPath, page, revision, snippet}` — every citation resolves to a chunk retrieved for that answer (validity invariant, FR-11).

### Evaluation (PRD F-6)
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/v1/evals` | reviewer+ | run history: `{runId, fixtureVersion, startedAt, gates: {recallAt5, refusalAccuracy, citationValidity, groundedRate}, passed}` |
| GET | `/api/v1/evals/{runId}` | reviewer+ | full metrics + per-case results summary |
| POST | `/api/v1/evals` | reviewer+ (service account) | persists one run's report; body = metrics + fixture version + case summaries. Written only by the eval CLI (`pnpm eval:mro`), which drives the *public* endpoints above — eval tests the product, not internals |

### Engine Health (PRD F-5)
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/v1/engines` | viewer+ | fleet: per-unit `{unitId, latestRul, bandLow, bandHigh, modelVersion, status, alertCount}` — `latestRul` is `null` until the unit has ≥ minimum window for scoring (renders "—", never 0; D-15 honesty precedent) |
| GET | `/api/v1/engines/{unitId}` | viewer+ | prediction history, trend series (labeled axes), alerts, thresholds |
| POST | `/api/v1/engines/score-fleet` | engineer+ | synchronous rescoring via ai-service; returns per-unit results + `modelVersion` |
| GET | `/api/v1/engines/alerts` | viewer+ | `status` filter; `{alertId, unitId, projectedRul, threshold, leadCycles, raisedAt, state}` |
| POST | `/api/v1/engines/alerts/{id}/acknowledge` | engineer+ | `raised → acknowledged` |
| POST | `/api/v1/engines/alerts/{id}/resolve` | engineer+ | `{note}` · `→ resolved` |

### Admin / Ingest (PRD US-10)
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/v1/admin/ingest` | reviewer+ | triggers ai-service ingest job (idempotent); 200 + report `{corpusDigest, chunks: {new, changed, unchanged}, embeddingModel, durationMs}` · 409 `INGEST_IN_PROGRESS` |
| GET | `/api/v1/admin/ingest/runs` | reviewer+ | `cursor` · ingest run reports |

### Health
`GET /healthz`, `GET /readyz` on **both** services (readyz: DB, pgvector, model artifact, provider status).

## 2. Error Envelope (`packages/contracts`)

```json
{ "error": { "code": "AI_SERVICE_UNAVAILABLE", "message": "retrieval backend did not respond", "details": { "mode": "lexical" }, "requestId": "req_01J…" } }
```

Codes: shared standard (`VALIDATION_ERROR` 400 · `UNAUTHENTICATED` 401 · `FORBIDDEN` 403 ·
`NOT_FOUND` 404 · `IDEMPOTENCY_CONFLICT` 409 · `RATE_LIMITED` 429 · `INTERNAL` 500) plus
mro-copilot additions: `INGEST_IN_PROGRESS` 409 · `MODEL_NOT_LOADED` 503 ·
`AI_SERVICE_UNAVAILABLE` 503 · `SELF_APPROVAL_FORBIDDEN` 403.

## 3. ai-service Internal API (`/internal/v1`, bearer `AI_SERVICE_TOKEN`, never public)

| Method | Path | Body → Response |
|---|---|---|
| POST | `/internal/v1/embed` | `{texts: string[]} → {model, vectors: number[][], usage}` |
| POST | `/internal/v1/retrieval/search` | `{query, k, filters?: {docTypes?, ataChapters?, revision?}} → {mode: "hybrid"\|"lexical", results: [{chunkId, manualId, score, snippet, metadata}]}` — query embedding happens inside (ADR-0012) |
| POST | `/internal/v1/rul/predict` | `{unitId} → {unitId, cycle, rulCycles, bandLow, bandHigh, modelVersion, modelSha256}` |
| POST | `/internal/v1/rul/score-fleet` | `{unitIds: string[]} → {modelVersion, results: [<predict shape>]}` |
| POST | `/internal/v1/ingest` | runs the ingest job (same code path as the CLI); 200 report / 409 in-progress |
| GET | `/internal/v1/model` | `{version, sha256, trainedAt, dataset, metrics: {rmse, nasaScore}}` |

- The gateway port (ADR-0012) mirrors `packages/llm-gateway`'s `complete`/`embed`
  semantics — same request/response field names and `ProviderUnavailable` behavior;
  cross-language parity is asserted by contract tests.
- Errors: RFC-7807-style `{title, status, code, detail, requestId}` JSON.

## 4. Behavioral Contracts (CI-asserted)

- **Refusal integrity**: `status: "refused"` responses never contain `answer` or `citations`.
- **Citation validity**: every `citations[]` entry's `chunkId` ∈ retrieval result set of
  that answer's `retrieval_meta`.
- **Source honesty**: `source: "extractive"` ⟺ answer text is verbatim chunk content
  (concatenated); `provider` is always disclosed.
- **Idempotent ingest**: same corpus digest ⇒ identical chunk-hash set + counts.
- **Provenance**: any RUL number in any response carries `modelVersion` + `modelSha256`.
- **Additive evolution**: new fields only; behavior changes ⇒ new endpoint/version
  (mirrors turnaround-iq contract discipline).
