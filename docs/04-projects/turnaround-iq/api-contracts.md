# TurnaroundIQ — API & Event Contracts

| Field | Value |
|---|---|
| Status | Approved — schemas live in `packages/contracts` (zod) |
| Conventions | REST prefix `/api/v1` · cursor pagination · standard error envelope · `Idempotency-Key` on mutations |

## 1. REST Endpoints

### Auth
| Method | Path | Role | Body/Query | Response |
|---|---|---|---|---|
| POST | `/api/v1/auth/login` | — | `{email, password}` | `{user, token}` · sets httpOnly session cookie |
| POST | `/api/v1/auth/logout` | any | — | 204 |
| POST | `/api/v1/auth/ws-token` | viewer+ | — | `{token, url}` — short-lived (≤ 60 s) purpose-scoped JWT for the ws upgrade (architecture.md §5); `url` points at the realtime gateway |

### Board & Flights
| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/v1/board` | viewer+ | `{ date }` → board snapshot: flights w/ task projections + KPI strip (fallback when WS is down) |
| GET | `/api/v1/flights/{id}` | viewer+ | flight + tasks + alert lifecycle |
| GET | `/api/v1/flights/{id}/events?cursor=` | viewer+ | audit replay, cursor-paginated, `Last-Event-Id` style |
| GET | `/api/v1/events?aggregateId=&after=` | viewer+ | catch-up replay for WS reconnect |

### Alerts & Replan
| Method | Path | Role | Body | Notes |
|---|---|---|---|---|
| POST | `/api/v1/alerts/{id}/acknowledge` | coordinator+ | — | `raised → acknowledged` |
| POST | `/api/v1/alerts/{id}/resolve` | coordinator+ | `{note}` | `→ resolved` |
| POST | `/api/v1/flights/{id}/replan` | coordinator+ | — | computes proposal (PRD F-4); **does not apply** |
| POST | `/api/v1/replans/{id}/approve` | coordinator+ | — | applies approved plan |
| POST | `/api/v1/replans/{id}/reject` | coordinator+ | `{reason}` | audit-recorded |
| GET | `/api/v1/replans/{id}/explanation` | viewer+ | — | copilot text + `{source: "llm"\|"rules"}` label (ADR-0003) |

### Scenarios (supervisor only)
| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/scenarios` | list scripted scenarios + status |
| POST | `/api/v1/scenarios/{id}/start` | `{speed: 1\|5\|20}` |
| POST | `/api/v1/scenarios/{id}/inject` | `{disruptionId}` (loader breakdown, gate swap, …) |
| POST | `/api/v1/scenarios/{id}/reset` | stops clock, truncates projections, replays seed; returns new `logHash` |

### Health
`GET /healthz`, `GET /readyz` on every service.

## 2. Error Envelope (`packages/contracts`)

```json
{ "error": { "code": "REPLAN_INFEASIBLE", "message": "2 constraints unresolvable: fueling window, gate curfew", "details": { "taskId": ["…"] }, "requestId": "req_01J…" } }
```
Codes: `VALIDATION_ERROR` 400 · `UNAUTHENTICATED` 401 · `FORBIDDEN` 403 · `NOT_FOUND` 404 · `IDEMPOTENCY_CONFLICT` 409 · `REPLAN_INFEASIBLE` 422 · `RATE_LIMITED` 429 · `INTERNAL` 500.

## 3. WebSocket Protocol

- Connect: `GET /api/ws?token=<short-lived jwt>` → channels subscribe: `board`, `flight:{id}`. The endpoint is served by the realtime-gateway service (architecture.md §2) on its own port (compose publishes 4001; `NEXT_PUBLIC_WS_URL` carries the browser-facing URL).
- Every frame: envelope `{ id, ts, channel, type, payload, lastEventId }`.

| Type | Payload (essence) |
|---|---|
| `task.state_changed` | `{flightId, taskId, state, scenarioTs, slaRemainingMin}` |
| `flight.delay_risk` | `{flightId, projectedOffBlock, delayMin, causeTaskId}` |
| `alert.raised` / `alert.acknowledged` / `alert.resolved` | `{alertId, flightId, ruleId, severity, leadTimeMin}` |
| `replan.proposed` | `{replanId, flightId, delta: [{taskId, newStart, newEnd}], totalDelayMin, rationale}` |
| `kpi.updated` | `{onTimeDep %, avgTurnMin, activeAlerts, delayMinutesSaved}` |
| `scenario.tick` | `{scenarioTs, speed}` |

- Coalescing: ≤ 10 Hz per client per channel; clients catch up via `/api/v1/events?after=lastEventId`.
- Breaking envelope changes = new `type` version suffix (`task.state_changed.v2`), never in-place mutation.

## 4. Rule & Replan Contracts (internal, replan-engine)

- Risk rule input: projection snapshot `{flight, tasks[], now, deps[]}` → output `{ruleId, severity, projectedBreachTs, leadTimeMin, causeTaskId} | null`.
- Scheduler input: remaining tasks + constraints (deps, unit availability, fuel/boarding overlap, stand curfew) → output: feasible plan minimizing Σdelay; infeasible → `{plan|null, conflicts[]}` (never violates constraints silently).
- Determinism: same event log + same seed ⇒ byte-identical plan (tested in CI).
