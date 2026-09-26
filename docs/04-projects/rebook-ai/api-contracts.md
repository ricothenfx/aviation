# Rebook.ai — API & Event Contracts

| Field | Value |
|---|---|
| Status | Approved 2026-09-26 |
| Conventions | `/api/v1` prefix; standard error envelope (`packages/contracts`); every mutating endpoint accepts `Idempotency-Key`; auth = session cookie (`rbo_session`, D-09) |

## 1. REST Endpoints (web app, `apps/rebook-ai`)

| Method & path | Roles | Purpose / notes |
|---|---|---|
| `POST /api/v1/auth/login` | public | `{email, password}` → session cookie; returns `{id, email, displayName, role}`. Errors: `UNAUTHENTICATED`. |
| `POST /api/v1/auth/logout` | any | Clears session. |
| `GET /api/v1/pax/summary` | passenger+ | Current user's disruption state: active disruption, offer set (or honest `null` = none), vouchers, notifications. Ownership-scoped. |
| `GET /api/v1/pax/offers/{offerId}` | passenger+ | One offer set + ranked options + per-rank reasons. 404 unless owner (or agent/supervisor). |
| `POST /api/v1/pax/offers/{offerId}/confirm` | passenger+ | Body `{optionId}`; `Idempotency-Key` required; opens the fulfillment saga. 409 `OFFER_EXPIRED` / `IDEMPOTENCY_CONFLICT`. Interline option ⇒ `FORBIDDEN` for passengers (agent/supervisor path). |
| `GET /api/v1/pax/vouchers` | passenger+ | Own vouchers + criteria (explainable, PRD F-3). |
| `GET /api/v1/pax/notifications` | passenger+ | Own inbox rows (SNS-shaped, simulated delivery states). |
| `GET /api/v1/queue` | agent+ | Live agent queue snapshot (priority-sorted; containment metric included, PRD F-4). |
| `GET /api/v1/pnr/{locator}` | agent+ | PNR-like record + segments + disruption context (agents only). |
| `POST /api/v1/pnr/{locator}/proposal` | agent+ | Request an agent-loop proposal (architecture §3.3); `Idempotency-Key` honored; returns proposal id, polls via GET. |
| `GET /api/v1/proposals/{id}` | agent+ | Proposal state incl. tool trace + `source`/`provider` badges. |
| `POST /api/v1/proposals/{id}/approve` | agent+ (supervisor for interline/over-cap) | Applies via the saga path; append-only audit. 403 `FORBIDDEN` when elevation required. |
| `POST /api/v1/proposals/{id}/reject` | agent+ | Mandatory `note`. |
| `POST /api/v1/sagas/{id}/compensate` | supervisor | Manual compensation after a failure (audited). |
| `POST /api/v1/scenario/inject` | supervisor | Body `{scenario: "cancellation" | "long-delay", flightNo}` → appends `flight.disrupted` (demo console, F2+). |
| `GET /api/v1/live` | passenger+ (F2, additive) | SSE bridge from `chan:rb:live` (architecture §4): validated frames; passenger streams scoped to own PNRs (offers/saga only), agent+ also get `queue.delta`. |
| `GET /api/v1/admin/events?processed=false` | supervisor (F2, additive) | Poison-event view: `processed=false` rows with attempts + error note (architecture §6 — never silently dropped). |
| `GET /healthz`, `GET /readyz` | public | Liveness / dependency readiness (db, provider) — engineering-standards.md §5. |

Error envelope (`packages/contracts`, api error schema): `{error: {code, message, details?, requestId}}`.
Rebook-specific codes join `ERROR_CODES` additively: `OFFER_EXPIRED`, `SAGA_CONFLICT`,
`PROPOSAL_NOT_PENDING` (existing codes unchanged).

## 2. Event Vocabulary (`packages/contracts`, additive)

Envelope: `{id, type, occurredAt, aggregateType, aggregateId, sequence, payload}`
(engineering-standards.md §4). Rebook types (aggregate types `flight | pnr | offer | saga | voucher | proposal | notification`):

| Type | Producer | Payload highlights |
|---|---|---|
| `flight.disrupted` | scenario inject | `flightNo`, `disruptionKind (cancellation | long_delay)`, `delayMinutes`, `reasonCode` |
| `offer.created` | orchestrator | `pnrId`, `offerId`, `optionCount`, `voucherIssued` |
| `offer.expired` | orchestrator | `offerId`, `reason` |
| `offer.confirmed` | web | `offerId`, `optionId`, `byRole`, `sagaId` |
| `saga.step.completed` | orchestrator | `sagaId`, `step`, `latencyMs` |
| `saga.failed` | orchestrator | `sagaId`, `step`, `errorCode` |
| `saga.compensated` | orchestrator | `sagaId`, `compensatedSteps[]` |
| `booking.issued` | orchestrator | `sagaId`, `pnrId`, `newFlightNo`, `boardingPassRef` |
| `voucher.issued` | orchestrator | `voucherId`, `pnrId`, `criteria` |
| `notification.sent` | orchestrator | `notificationId`, `pnrId`, `channel: "inbox"` |
| `proposal.created` | orchestrator | `proposalId`, `pnrId`, `source (llm | rules)`, `provider` |
| `proposal.approved` / `proposal.rejected` | web | `proposalId`, `approverId`, `note?` |

Payload schemas are zod in `packages/contracts` (`typedDomainEventSchemas`); producers
validate before append, consumers before apply. Additive evolution only (D-11/D-14 precedent).

## 3. Redis Frames (live channel, F2+)

`chan:rb:live` frames reuse the ws envelope shape: `{id, ts, channel, type, payload, lastEventId}` —
frame types: `queue.delta`, `offers.update`, `saga.update`. Additive frame types only;
clients resync via the REST snapshot endpoints (D-14 batch-envelope precedent if scale demands it).

## 4. Orchestrator Internal Surface (:4104, loopback-only)

`/healthz`, `/readyz` (postgres, redis, provider), `/metrics` (Prometheus text format:
saga counters by state, proposal latency histogram, notification lag gauge). No domain
REST: commands arrive via `chan:rb:control` + result keys (architecture §1, ADR-0014).

## 5. Behavioral Contracts (CI-asserted)

- Confirm idempotency: same `Idempotency-Key` ⇒ identical response, exactly one charge/issue (PRD §5).
- Expiry: confirming an expired offer ⇒ 409 `OFFER_EXPIRED`; no saga opens.
- Proposal inertness: `proposal.created` never mutates booking state; only approval does (RBAC-gated).
- Degrade honesty: provider off ⇒ `source: "rules"` badge end-to-end (API + UI), never unlabeled.
- Audit completeness: every approve/reject/confirm writes an `audit_events` row; the trail
  answers "who decided what for whom, when".
