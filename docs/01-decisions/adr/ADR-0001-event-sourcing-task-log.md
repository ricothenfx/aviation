# ADR-0001: Event Sourcing for the Ground-Task Log (turnaround-iq)

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-09-22 |
| Supersedes | — |
| Related | D-04, data-model.md |

## Context

The turnaround command center must show a live, trustworthy picture of every ground task
(baggage, catering, fueling, cleaning, boarding, pushback) and must support:
replayable disruption scenarios for demos, an audit trail ("why was this flight delayed"),
and projections (timeline views, KPIs) derived from the same stream.

## Decision

All ground-task and flight state changes are persisted as **immutable events** in an
append-only `event_log` table. Current state is materialized as **projections**
(read models) built by idempotent event handlers. The simulator is the event producer;
no code path mutates projections directly.

## Alternatives considered

1. **CRUD tables + polling** — simplest, but no replay, no audit trail, demos depend on ad-hoc state mutation; rejected.
2. **Full event-store framework (EventStoreDB/Kafka)** — operationally heavy for a portfolio-scale system; rejected in favor of PostgreSQL as the log (outbox-friendly, one less moving part).

## Consequences

- (+) Deterministic scenario replay; "47 → 9 minutes" replan narratives are provable.
- (+) Audit trail is a natural output (senior-signal for reviewers).
- (−) Read-model consistency must be engineered (idempotency keys, monotonic sequence per aggregate).
- (−) Event schema versioning discipline required (see api-contracts.md event envelope).

## Compliance

Any code that updates a projection outside an event handler is a defect. CI should include an integration test that replays the full seed log and asserts projections match golden state.
