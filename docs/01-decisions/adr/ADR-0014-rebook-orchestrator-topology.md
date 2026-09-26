# ADR-0014: Rebook.ai Orchestration Topology — TS Worker + Postgres Queue-of-Record, Propose-Only Agent, Compensable Saga

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-09-26 |
| Supersedes | — |
| Related | D-11 precedent (worker-service topology), ADR-0003 (LLM gateway), D-10 (degrade-to-rules), tech-stack.md §2–3, rebook-ai architecture.md §1–3 |

## Context

Rebook-ai needs background domain work: disruption→offer ranking, an agentic rebooking
workflow, a seat-reserve → payment → ticket-issue fulfillment path, and notifications.
The PRD skeleton names "orchestrator service + agent loop via `packages/llm-gateway`" and
an "SNS-shaped notification abstraction". The stack is locked: no new queue systems or
workflow engines without an ADR (tech-stack.md §3).

## Decision

1. **One TS worker service** (`services/rebook-ai/orchestrator`, loopback :4104) owns all
   background domain work; the Next.js app owns REST/UI/auth. The browser never reaches
   the orchestrator — web submits commands via PostgreSQL state + a Redis control channel
   with result keys (the D-11 replan-engine pattern), no HTTP hop.
2. **PostgreSQL is the queue of record.** The event log + saga tables drive the worker
   (poll/tail); Redis carries only live projections + pub/sub and control/result messages.
   No message broker: at portfolio scale a transactional table beats an extra moving part,
   and crash-safety comes free (saga state persists with business data in one transaction).
3. **Agent loop is propose-only and bounded**: tools (`search_routings`, `price_itinerary`,
   `check_policy`) are read-only over the simulated inventory/policy; the loop has a max
   round count and persists a full tool trace; its output is a proposal that applies only
   after role-gated human approval, through the same saga path as self-serve confirms
   (no side door). Bedrock AgentCore-shaped per tech-stack.md §2.
4. **Fulfillment is a compensable saga**: `seat_reserve → payment → ticket_issue`, each
   step idempotent by key, persisted per-step so a restarted worker resumes or compensates
   from durable state. Failure ⇒ compensation in reverse order; no zombie sagas.
5. **Notifications** go through a single `NotificationPublisher` interface whose AWS
   target is SNS (tech-stack.md §2); the local implementation writes the in-app inbox +
   Redis fan-out (simulated delivery, honestly labeled).

## Alternatives considered

1. **Domain logic inside the Next.js app** — fewer moving parts; rejected: blurs the
   web/worker boundary the portfolio's other projects demonstrate (D-11 rationale), and
   long-running saga/agent work does not belong in request handlers.
2. **Redis Streams / a broker as the work queue** — cleaner retry semantics; rejected:
   queue systems are locked out (tech-stack.md §3), and a second source of truth would
   complicate crash recovery for sub-million-row scale.
3. **LLM proposes and auto-applies for low-risk cases** — more "agentic"; rejected: the
   PRD fixes human approval (F-5) and an unsupervised booking-mutation path is the exact
   production risk this portfolio should demonstrate guarding against.
4. **Temporal-style workflow engine** — the honest industry answer for sagas; rejected:
   new infrastructure outside the locked stack, and a hand-rolled persisted-state saga is
   defensible at this scale and more instructive.

## Consequences

- (+) Crash-safe fulfillment without new infrastructure; full audit in one database.
- (+) The propose-only agent is a strong production-readiness interview story.
- (−) The worker duplicates small amounts of web-side plumbing (health, logging, control
  channel) — accepted, mirrors D-11.
- (−) Polling latency (~300 ms) is on the critical path — well inside the 10 s offer gate.
