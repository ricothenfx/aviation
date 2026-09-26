# Rebook.ai — Architecture

| Field | Value |
|---|---|
| Status | Approved 2026-09-26 (build target F1–F5) |
| Decisions | ADR-0003 (LLM gateway), ADR-0004/D-08 (monorepo), ADR-0014 (orchestrator topology + saga), ADR-0015 (JSONB document store), D-09 (auth), D-10 (degrade-to-rules) |

## 1. System Overview

```
                      ┌──────────────────────────── compose profile "rebook" ───────────────────────────┐
                      │                                                                                 │
 Browser ──HTTP──▶  rebook-web (:3004)  ──REST──▶  PostgreSQL 16 (DB rebook_ai)  ◀──tail/poll──  rebook-orchestrator (:4104)
 passenger UI         Next.js App Router            event_log, offers,              outbox/saga        TS worker service
 agent console        UI + /api/v1 REST             sagas, audit, users             queue updates
                      auth (D-09)                          ▲                              │
                      │                                    │                        Redis 7 (pub/sub + live state)
                      └── ws/sse ◀─────────────────────────┴────────── live queue + offer updates ◀┘
                                                                                                        │
                                                                              packages/llm-gateway (ADR-0003, mock provider)
                                                                                                        │
                                                                              fictional inventory/policy/PSP stubs (in-DB, simulated)
```

Two services, one database, one cache (monorepo-architecture.md §3; per-project DB in the
shared cluster, D-11 precedent):

- **rebook-web** (`apps/rebook-ai`, Next.js :3004) — passenger surface + agent console UI,
  all public REST (`/api/v1`), AuthN/AuthZ (D-09), and the append-only write path into
  PostgreSQL (event log + state tables).
- **rebook-orchestrator** (`services/rebook-ai/orchestrator`, TS worker :4104) — the
  domain worker: scenario clock + disruption injection, offer ranking engine, the agentic
  proposal workflow (LLM via `packages/llm-gateway`), the fulfillment saga executor, and
  the notification publisher (SNS-shaped abstraction, simulated delivery). Internal-only
  service: the browser never talks to it; REST reaches it the same way turnaround-iq's
  replan-engine is reached — PostgreSQL as the queue of record + Redis control/result
  (ADR-0014; no new queue system, tech-stack.md §3).

## 2. Component Responsibilities

| Component | Owns | Never does |
|---|---|---|
| rebook-web | REST contracts, session auth, offer/queue/saga rendering, `Idempotency-Key` replay store, audit writes for UI-originated decisions | Domain computation (ranking, policy, saga advancement) |
| rebook-orchestrator | Scenario clock, disruption detection (`flight.disrupted`), offer ranking + expiry, voucher rules, agent loop (propose-only), saga execution + compensation, notification publisher, live queue projections into Redis | Direct browser-facing REST; unauthorized state mutation (proposals are inert until approved) |
| packages/contracts | Event envelope + rebook event payload schemas (zod), API error envelope | Project-specific domain logic (D-08) |
| packages/llm-gateway | Provider abstraction (`complete/embed`), mock provider, token accounting | Vendor SDKs in feature code (tech-stack.md §3) |

## 3. Core Flows

### 3.1 Disruption → offers (proactive, PRD F-1/F-2/F-3)

1. Scenario console (supervisor) POSTs an inject command → web app appends `flight.disrupted`
   to `event_log` and writes the flight row's status transition.
2. Orchestrator tails the event log (poll, D-11 pattern): for each affected PNR it
   evaluates voucher criteria (PRD F-3), ranks candidate itineraries from the fictional
   inventory (fast/cheap/flexible with per-rank reasons), appends `offer.created` events,
   inserts offers, and publishes the SNS-shaped notification (in-app inbox row + Redis
   pub/sub fan-out).
3. Passenger UI receives the live update (< 1 s) and the offer set is visible within the
   10 s p95 gate (PRD §5).

### 3.2 Confirm → saga fulfillment (PRD F-6)

1. Passenger (or agent on their behalf) confirms an offer with an `Idempotency-Key`;
   web app inserts the confirmation + opens the saga (`seat_reserve → payment → ticket_issue`).
2. Orchestrator advances saga steps against simulated inventory/PSP stubs; every step
   appends `saga.step.completed` (or `saga.failed`) and is idempotent per step key
   (ADR-0014 §4). On failure: compensation in reverse order, passenger returns to the
   queue with an honest state, `booking.issued` only after the final step.
3. Success appends `booking.issued` + issues the new boarding pass (demo beat, demo-script.md).

### 3.3 Agentic proposal (PRD F-5, ADR-0003 + AgentCore-shaped tool loop)

1. Agent (or supervisor) requests a proposal for a queue item; web app enqueues the
   request; orchestrator runs the tool loop: `search_routings` → `price_itinerary` →
   `check_policy` → `draft_proposal`. Tools read the simulated inventory/policy only.
2. The loop is bounded (max tool rounds), traced (every tool call + token usage persisted),
   and **propose-only**: the output is a decision proposal requiring human approval.
3. Provider unavailable ⇒ deterministic rule-based proposal labeled `source: "rules"`
   (D-10 degrade path, honestly badged in the UI). Mock provider ⇒ `source: "llm", provider: "mock"`.
4. Approval applies the proposal through the same saga path as 3.2 (no side door);
   interline or over-cap proposals require `supervisor` (RBAC).

## 4. Realtime & Consistency

- **Source of truth**: PostgreSQL. Redis holds live projections (queue order, offer state)
  + pub/sub; losing Redis degrades freshness, never correctness (rebuild by replay).
- **Live channel**: Redis pub/sub → web app SSE/ws bridge for queue + passenger updates;
  envelopes from `packages/contracts` (additive frame types only, D-14 precedent).
- **Idempotency everywhere**: every mutating REST endpoint accepts `Idempotency-Key`
  (engineering-standards.md §4); saga steps are idempotent per step key; event appends are
  unique per (aggregateId, sequence).

## 5. AuthN / AuthZ (D-09)

- Same Cognito-shaped provider interface as the other projects; local implementation =
  seeded users + argon2id + JWT session cookie (`rbo_session`, issuer `rebook-ai`).
- Roles: `passenger(0) < agent(1) < supervisor(2)` ladder for capability tiers, plus
  ownership scoping: a passenger resolves only their own PNR's offers; agents act for any
  PNR; supervisor for interline/over-cap approvals, policy overrides, scenario control.
- All enforcement server-side (route handlers + orchestrator control channel); RBAC test
  matrix is a standing CI gate from F1.

## 6. Failure Handling

- Orchestrator step retries with exponential backoff + jitter; a step that exhausts
  retries fails its saga deterministically into compensation (no zombie sagas: a stuck
  saga is re-driven from its persisted step state on restart — crash-safe by design).
- Poison events land in `event_log` with `processed=false` + error note and surface in the
  supervisor console — never silently dropped (engineering-standards.md §6).
- Notification publisher failures mark the inbox row `failed` for visible retry, and do
  not block the offer pipeline.
- Graceful shutdown: stop polling, finish in-flight saga steps, flush, close on SIGTERM.

## 7. Observability (F5 evidence)

- Structured pino JSON logs (`ts, level, requestId, module, msg`) on both services;
  one request ID per inbound request/event, propagated through saga steps and agent loops.
- Orchestrator exposes `/healthz` (liveness), `/readyz` (postgres, redis, LLM provider)
  and `/metrics` (Prometheus text: saga counters, proposal latency, notification lag).
- Web app: `/healthz`, `/readyz` (db, provider). F5 adds k6 evidence per milestones.md.

## 8. Deployment Shape

Local compose mirrors D-12/D-18 topology discipline: `rebook-web` :3004 (loopback),
`rebook-orchestrator` :4104 (loopback, service-network name only), shared postgres +
redis. AWS mapping (tech-stack.md §2): web → ECS Fargate/Amplify; orchestrator → ECS
Fargate worker; `event_log` fan-out → SQS/SNS-shaped; notifications → SNS; RDS
PostgreSQL; ElastiCache Redis. Live demo deploy (F5) follows the D-12 single-VPS
compose + Caddy pattern.
