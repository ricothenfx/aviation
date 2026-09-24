# ADR-0012: mro-copilot AI Topology — Python ai-service for Embedding/Retrieval/RUL, TS App for RAG Orchestration

| Field | Value |
|---|---|
| Status | Accepted (user approval 2026-09-24, closing mro-copilot F0) |
| Date | 2026-09-24 |
| Supersedes | — |
| Related | D-03, D-08, D-10, ADR-0003, ADR-0010, ADR-0011, tech-stack.md §1/§2 |

## Context

D-03 locks: TypeScript/Next.js for product code, **Python FastAPI only for AI-serving
services**, and tech-stack.md pins the split for this project explicitly —
"mro-copilot model serving" in Python, "turnaround-iq copilot stays TS via llm-gateway".
mro-copilot needs three AI capabilities: text embedding + vector/lexical retrieval,
RAG answer generation, and RUL prediction. ADR-0003 requires all LLM access to run
through a provider-agnostic gateway (mock provider mandatory, Bedrock-shaped interface)
with graceful degradation. `packages/llm-gateway` is TypeScript; the Python side cannot
import it, yet embedding must happen where chunking/indexing and query-time embedding
live.

## Decision

1. **One Python service**: `services/mro-copilot/ai-service` (FastAPI, port 4103) owns
   **embeddings, retrieval (pgvector hybrid, ADR-0010), and RUL inference (ADR-0011)**.
   It is the only mro-copilot component that talks to embedding providers.
2. The ai-service contains a **Python port of the ADR-0003 gateway interface**
   (`complete`/`embed`, same provider names `mock | openai-compatible | bedrock-shape`,
   same tracing/token-accounting shape, `ProviderUnavailableError` semantics). The mock
   embedding provider is a deterministic hashed bag-of-character-n-grams embedder
   (384-dim, L2-normalized) — *not* the turnaround-iq TS mock (8-dim placeholder, never
   intended for retrieval). Cross-language embedding parity is explicitly NOT required:
   index-time and query-time embeddings are produced by the same Python provider, so the
   vector space is internally consistent.
3. **RAG orchestration lives in the Next.js app** (TS): query → ai-service retrieval →
   prompt assembly → `packages/llm-gateway.complete` → guardrail validation → citations.
   Guardrails (grounding threshold, refuse-when-ungrounded, citation validity) are TS
   application logic, versioned and unit-tested like any domain rule.
4. **Degradation**: when no LLM provider is configured/unavailable, the ask flow returns
   an **extractive fallback** (top retrieved chunks verbatim, question-matched) labeled
   `source: "extractive"` — the RAG analog of ADR-0003's rule-based fallback. The mock
   LLM provider counts as `source: "llm"` with `provider: "mock"` disclosed in the
   payload and UI.
5. The ai-service is **internal-only**: service-to-service calls from the app use a
   shared-secret bearer token (`AI_SERVICE_TOKEN`); it is never exposed on public
   interfaces (compose keeps it off the published-ports list except loopback for dev).

## Alternatives considered

1. **All AI in TS (extend packages/llm-gateway with retrieval + model serving)** —
   rejected: contradicts D-03/tech-stack.md (Python is locked for model serving), and the
   JS numeric-ML ecosystem is explicitly the reason D-03 exists.
2. **RAG orchestration in Python (one /rag/answer endpoint)** — rejected: sign-off
   workflow, audit, RBAC, and answer history are product domain logic; putting them in
   the service would split the product across languages and thin out the TS application
   layer this portfolio track is built to demonstrate (D-01).
3. **Embeddings in TS via packages/llm-gateway, retrieval SQL in TS too; Python only for
   RUL** — rejected: leaves "retrieval serving" (tech-stack.md §1 AI-serving row)
   unimplemented in its locked home, and makes ingest a TS job that must write vectors
   produced by a TS provider while the model side is Python — two AI runtimes doing one
   pipeline's work.
4. **Separate ingest service** — rejected: ingest is a deterministic batch job
   (chunk → embed → upsert), not a long-running service; it is a CLI module inside
   ai-service (`python -m mro_ai.ingest`), runnable in CI and compose exec.

## Consequences

- (+) Mirrors the AWS target honestly: Bedrock-shaped Python gateway ↔ Bedrock access
  from Lambda/Fargate AI components; TS app ↔ the product layer (tech-stack.md §2).
- (+) The retrieval stack (chunking, hybrid SQL, thresholds) is testable end-to-end in
  Python without any LLM, so retrieval quality gates run in CI offline.
- (+) Vector space consistency is guaranteed by construction (one embedder for index and
  query); no TS/Python embedding drift bug class exists.
- (−) The ADR-0003 gateway now exists in two languages; both must keep the same
  interface shape — enforced by contract tests that assert identical request/response
  field names and error semantics (documented duplication, deliberate per D-08's
  "no cross-project imports" rule).
- (−) An extra network hop per ask (app → ai-service); latency budgeted in PRD §5
  (p95 ask < 2.5 s with mock provider).
