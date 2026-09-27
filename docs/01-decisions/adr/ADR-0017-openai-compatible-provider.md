# ADR-0017: Completing the ADR-0003 `openai-compatible` Provider (Real LLM, Opt-in)

| Field | Value |
|---|---|
| Status | Accepted (2026-09-27, post-F5 hardening wave; requested and approved by the user in the live session) |
| Date | 2026-09-27 |
| Supersedes | — (executes the unimplemented half of ADR-0003 §Decision item (2); no prior decision is changed) |
| Related | D-10, D-23, ADR-0003, ADR-0012, ADR-0010, tech-stack.md §1 "LLM access", §3 |

## Context

All three milestones reached F5 with the LLM gateway running exclusively on the
deterministic mock provider (`LLM_PROVIDER=mock`, mandatory offline default per
ADR-0003). The gateway has always registered the provider names `openai-compatible`
and `bedrock-shape`, but `fromEnv` throws "registered but not implemented" for both —
the F4 copilot milestones shipped with mock only. The user has now (a) requested that
the portfolio demonstrate **real LLM answers alongside the mock**, supplying their own
OpenAI token, and (b) confirmed all milestones are complete, making this an explicit
post-F5 work order (D-05 scope discipline satisfied by this ADR + D-23).

Constraints that shape the decision:

- tech-stack.md §3: vendor SDK calls are prohibited outside `packages/llm-gateway`;
  no new frameworks without an ADR. A plain `fetch`-based HTTP provider inside the
  gateway package adds **zero dependencies** and is exactly what ADR-0003 pre-decided.
- D-07 honesty: the UI and contracts already label the answer `source` and `provider`
  per response (tiq `replanExplanationSchema.provider`, mro `ask` response `provider`,
  rebook proposal trace) — a real provider must surface under its real name, never
  disguised as mock.
- ADR-0012 §2 + ADR-0010: the mro ai-service (Python) **owns the embedding vector
  space** — `mock-hashed-ngram-384`, `chunks.embedding vector(384)` with an HNSW
  index, index- and query-time embeddings produced by the same provider "by
  construction". Flipping the Python gateway to real embeddings would change
  dimensionality, invalidate the committed corpus + index, and void the recorded eval
  (recall@5 0.9231) until a full re-ingest + re-eval — a migration, not a config flag.
- Demos and CI must stay offline-capable, deterministic, and cost-zero (ADR-0003).

## Decision

1. **TypeScript gateway** (`packages/llm-gateway`) ships `OpenAiCompatibleProvider`
   (provider name `openai-compatible`), selected via `LLM_PROVIDER=openai-compatible`:
   - plain `fetch` against `{OPENAI_BASE_URL}/chat/completions` and `/embeddings`
     (default base `https://api.openai.com/v1` — any OpenAI-compatible endpoint works,
     keeping the provider genuinely vendor-neutral in shape);
   - env: `OPENAI_API_KEY` (required — its absence raises `ProviderUnavailableError`
     naming the variable, so every existing degrade path fires), `OPENAI_BASE_URL`,
     `OPENAI_MODEL` (default `gpt-4o-mini`), `OPENAI_EMBED_MODEL`
     (default `text-embedding-3-small`), request timeout via `AbortSignal`;
   - the API key is **never** logged or embedded in error messages; non-2xx responses
     become `ProviderUnavailableError` with status + reason-phrase only;
   - token accounting maps `usage.prompt_tokens`/`completion_tokens` onto the existing
     `TokenUsage` shape; `bedrock-shape` remains registered-but-unimplemented.
2. **Python ai-service keeps `mock`/`off` only — by design.** The Python gateway's
   `openai-compatible` branch becomes an explicit, explanatory `ProviderUnavailableError`
   that names the vector-space lock (ADR-0012 §2 / ADR-0010) instead of the generic
   "not implemented" text. The dev compose pins `mro-ai-service` to `LLM_PROVIDER: mock`
   so a global `.env` provider switch can never silently flip embeddings; real LLM for
   mro **answers** flows through the TS gateway on `mro-web` (ask synthesis), where the
   citation post-check, grounding pre-check and refusal contract apply unchanged.
   Real embeddings require a future ADR (dimension migration + re-ingest + eval re-run).
3. **All three apps light up without feature-code changes** — every consumer already
   goes through `LlmGateway.fromEnv()` (tiq copilot `explain.ts`, mro ask route,
   rebook orchestrator): setting `LLM_PROVIDER=openai-compatible` + `OPENAI_API_KEY`
   in `.env` is the entire switch. Degrade semantics are unchanged and re-tested:
   any provider failure ⇒ tiq `source: "rules"`, mro `source: "extractive"`,
   rebook `source: "rules"` proposals.
4. **Mock stays the mandatory default** for tests, CI, e2e, benches and evals
   (deterministic, offline, zero cost). CI never requires the key; no secret enters
   the repository (`.env.example` documents the optional block; compose passes the
   three variables through only when set).
5. **Env plumbing**: dev compose adds `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`
   passthrough (`${VAR:-}` style) to tiq web, mro web, rebook web and the rebook
   orchestrator; `.env.example` gains a commented "optional real LLM" block.

## Alternatives considered

1. **Official OpenAI SDK** — rejected: tech-stack.md §3 prohibits vendor SDKs outside
   the gateway, and two `fetch` calls need no SDK; zero-dependency keeps the supply
   chain pinned and the architecture story clean.
2. **Real embeddings in the Python ai-service now** — rejected: dimension migration
   (`vector(384)` → model-native width), full corpus re-ingest, HNSW rebuild and eval
   invalidation for a demo-scale corpus whose retrieval quality is already measured and
   committed. Recorded as the future path, deliberately not taken now.
3. **Bedrock-shaped provider first** — rejected for this work order: the user asked for
   OpenAI specifically and holds a token; the Bedrock shape remains the documented AWS
   migration target (tech-stack §2) and stays unimplemented.
4. **Keep mock-only, document how to add a provider** — rejected: the user explicitly
   requested real-LLM capability, and ADR-0003 already committed to this provider; a
   fourth year of "registered but not implemented" would be an honest-docs defect.

## Consequences

- (+) Real LLM answers become a configuration flip per app; the UI provider badges,
  contract fields (`provider`), audit rows and traces report the real name honestly.
- (+) CI, e2e, benches and evals are untouched (mock default) — determinism and
  cost-zero guarantees survive.
- (−) A real provider makes copilot/ask/agent output non-deterministic by nature;
  anything that must stay reproducible must keep using mock (this is why mock remains
  the default, not a legacy fallback).
- (−) API cost and latency appear only on opt-in runs; the gateway timeout turns
  provider outages into the existing labeled degrade paths instead of 500s.
- (−) The Python/TS gateway interface-parity contract tests change meaning slightly:
  parity now covers interface + error semantics, while the implemented-provider sets
  intentionally diverge (TS: mock + openai-compatible; Python: mock) — pinned as such.
- Contract-test note: mro ask integration tests keep asserting `provider mock`
  labeling under the default env; a new unit suite pins the provider's request/response
  mapping, error mapping, and key redaction with an injected `fetch` (no new deps).
