# ADR-0003: Provider-Agnostic LLM Gateway with Local Mock Mode

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-09-22 |
| Supersedes | — |
| Related | D-10, engineering-standards.md |

## Context

Two projects (turnaround-iq copilot, mro-copilot RAG) need LLM calls. CAG's stack targets
**Bedrock / AgentCore**; the portfolio must stay vendor-neutral, run offline, cost nothing
in demos, and still demonstrate production AI practices (grounding, guardrails, evaluation,
human-in-the-loop).

## Decision

All LLM access goes through an internal **LLM gateway module** exposing a narrow interface
(`complete`, `embed`, `stream`) with request/response tracing and token accounting.
Implementations: (1) **mock/local** deterministic provider for tests and offline demos,
(2) OpenAI-compatible HTTP provider, (3) Bedrock-shaped provider (interface maps 1:1 to
InvokeModel/Converse semantics) so migration is configuration, not code.

Copilot features must implement **graceful degradation**: when no LLM provider is
configured, the rule-based engine answers instead and the UI labels the answer source.

## Alternatives considered

1. **Direct Bedrock SDK calls** — matches target stack; rejected: hard vendor coupling, no offline dev, demo cost/latency risk.
2. **LangChain-everything** — fast start; rejected as core dependency (opaque abstractions weaken the architecture story); allowed for narrow utilities if isolated.

## Consequences

- (+) Demos never fail on network/cost; tests are deterministic.
- (+) "Provider swap is config" is an architecture interview answer.
- (−) Gateway interface must be designed up front; mock provider must produce realistic-shaped responses.
- (−) Bedrock-conformance is by shape, not by integration test against real AWS — stated honestly in READMEs.
