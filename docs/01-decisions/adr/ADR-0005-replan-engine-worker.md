# ADR-0005: Replan Engine as an Event-Tailing Worker Service (turnaround-iq)

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-09-23 |
| Supersedes | — |
| Related | D-04, D-11, architecture.md §2–3, milestones.md §F3 |

## Context

Milestone F3 introduces the risk rule engine (SLA-breach projection ≥ 10 min lead,
PRD F-3) and the constraint scheduler (PRD F-4). Both need a long-running process:
the rule engine must evaluate every relevant event as it lands so alerts precede
breaches, and approved plans must be applied (task.rescheduled events) without a
human babysitting the clock. architecture.md §2 names a `replan-engine` service but
left its deployment shape open. Two additional decisions were confirmed with the
user on 2026-09-23: the completion of the replan lifecycle contract
(`replan.approved`/`replan.rejected`), and the deployment shape below.

## Decision

The replan-engine is a **sixth compose worker service** (profile `turnaround`):

- **Risk daemon**: tails `event_log` (PostgreSQL, poll backstop) — the log is the
  only decision input, never Redis (architecture.md §2). Findings become real
  `alert.raised` events (producer `replan_engine`) with deterministic ids (uuidv5
  over flight + rule + cause task + instant), so the same log replays to the same
  alerts (ADR-0001 determinism).
- **Replan RPC**: REST publishes a propose command on `chan:replan:control`; the
  engine computes from the log + PG baseline and answers via a short-TTL result
  key (`replan:result:{requestId}`) that the REST caller polls. Infeasible inputs
  surface as `REPLAN_INFEASIBLE` (422) with the conflict list — constraints are
  never silently violated (architecture.md §6).
- **Plan application**: `replan.approved` (producer `user_action`, appended by the
  REST layer) triggers one `task.rescheduled` event per moved task; the simulator
  adopts them by amending its plan, and the gateway projects the new windows into
  Redis + PG. The LLM stays explain-only (ADR-0003, PRD §4).

The lifecycle contract is completed additively: `replan.approved` and
`replan.rejected` join the event vocabulary and ws frame map (symmetric with the
alert lifecycle), plus optional payload fields (`blockedUntil`, `standCurfew`,
`causeTaskId`, `actor`, `baselineDelayMin`, `planHash`). No existing payload
changes; F2 logs replay unchanged (golden fixture untouched).

## Alternatives considered

1. **Rule engine inside the Next.js web container** — fewer containers, but blurs
   "API must not compute schedules" (architecture.md §2) and weakens the service
   decomposition story; rejected.
2. **HTTP service with its own port for RPC** — adds network plumbing for a
   single command type; the Redis control channel already exists as the established
   control-plane pattern (simulator start/reset/speed); rejected.
3. **Alerts computed inside the projection worker** — the gateway's contract
   forbids business logic (architecture.md §2); rejected.

## Consequences

- (+) Risk evaluation latency is bounded by log-tail polling (300 ms), independent
  of UI traffic; alerts are audit-complete events, not ephemeral rows.
- (+) Determinism is testable end-to-end: same seed + log ⇒ identical plan hash
  (unit + integration tests, benchmark committed under `scripts/benchmarks/`).
- (−) One more container to build and watch in CI (compose + e2e workflows).
- (−) Per-aggregate sequence contention between simulator and engine appends is
  resolved by retry-on-unique-violation; documented in the engine event-log module.

## Compliance

The engine must never read Redis for decisions (control-plane messages and result
keys are transport, not truth). Any projection write happens inside the event
handler path (gateway) or via engine-appended events, never out-of-band.
