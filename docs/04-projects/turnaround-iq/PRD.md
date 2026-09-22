# TurnaroundIQ — PRD

| Field | Value |
|---|---|
| Status | Approved — build target F1–F5 |
| Version | 1.0 (2026-09-22) |
| One-liner | AI-assisted aircraft turnaround command center: one live screen for every ground task, with risk prediction and one-click AI replanning. |

## 1. Problem Statement

A narrow-body aircraft turnaround involves ~10 concurrent ground tasks (alighting,
baggage unload/load, catering, cleaning, fueling, boarding, pushback) coordinated by
a duty manager juggling radio calls, spreadsheets, and a static Gantt.

1. **No single source of truth.** Task progress lives in people's heads and radio chatter; the ops board is minutes-to-hours stale.
2. **Late detection.** A missing baggage loader is only noticed when it has already consumed the schedule buffer — and one late aircraft cascades into gate conflicts and crew overtime across the afternoon bank (delay propagation is the norm, not the exception).
3. **Replanning is manual and slow.** When a disruption hits, the coordinator re-sequences tasks from experience under time pressure; the quality of the plan depends entirely on who is on shift.

Outcome today: preventable secondary delays, high coordinator cognitive load, zero audit trail for post-mortems.

## 2. Users & Jobs-to-be-Done

| User | Job-to-be-done |
|---|---|
| **Turnaround coordinator** (primary) | "Show me which turnarounds are about to break, before they break — and help me fix them in seconds." |
| **Duty/supervision manager** | "Give me the state of the whole bank, the audit trail of every decision, and KPIs I can defend." |
| **Interviewer (demo persona)** | Understand the problem, see the product work, and assess engineering quality — in under 10 minutes. |

## 3. In-Scope Features

| ID | Feature | Acceptance highlights |
|---|---|---|
| F-1 | **Live turnaround board** — Gantt/timeline of all turns for the day, per gate/stand, tasks as color-coded lanes, updating in real time via WebSocket | Updates appear < 1 s after event ingestion; visible freshness cue |
| F-2 | **Flight drawer** — task checklist with SLA countdowns, dependencies, event history (audit), flight metadata | Full task history replayable from event log |
| F-3 | **Risk detection & alerts** — rule engine flags projected SLA breaches ≥ 10 min ahead (e.g., "baggage load blocked → departure at risk") | Alert leads simulated breach by ≥ 10 min in reference scenario; alert lifecycle (raised/ack/resolved) |
| F-4 | **One-click AI replan** — constraint engine re-sequences remaining tasks minimizing total delay; LLM copilot explains the plan in natural language; coordinator approves/rejects (human-in-the-loop) | Reference scenario: total delay 47 → ≤ 9 min; replan computed < 2 s; every proposal shows rationale + affected tasks |
| F-5 | **Disruption simulator console** — scripted scenarios (loader breakdown, gate swap, crew no-show, weather hold) with speed control; drives F-1–F4 deterministically | Seed + scenario reset reproducible byte-identically (event log hash) |
| F-6 | **Ops KPI strip** — on-time departures, average turn time, active alerts, delay minutes saved by replans | Honest definitions documented; counts derived from projections |
| F-7 | **RBAC + auth** — seeded users; roles: viewer (read-only), coordinator (ack alerts, approve replans), supervisor (everything + scenario control) | Unauthorized actions blocked server-side, not just hidden |

## 4. OUT OF SCOPE (binding — do not build)

- Real ADS-B / ACARS / airport AODB integrations (the simulator stands in for all of them)
- Mobile native apps; tablet-perfect responsive is the bar
- Multi-airport or multi-day planning (one synthetic airport, one day per scenario)
- Crew/rostering optimization, gate allocation optimization (gate swaps are simulated inputs)
- Billing, payments, i18n, user registration flows (seeded users only)
- Real email/SMS/push notifications
- LLM driving replans autonomously — the LLM explains and prioritizes; the constraint engine decides; humans approve

## 5. Success Metrics (demo-verifiable)

| Metric | Target |
|---|---|
| Reference scenario total delay (with replan) | ≤ 9 min (from 47 min baseline) |
| Risk alert lead time | ≥ 10 min before projected breach |
| Replan computation | < 2 s for a 12-task turn |
| Event ingestion → board update | < 1 s p95 |
| Scenario replay determinism | identical event-log hash across resets |

## 6. Domain Primer (for agents new to aviation)

- **Turnaround**: ground process between in-block and off-block. Reference target ~35–45 min narrow-body.
- Key tasks: alighting, baggage unload, baggage load, catering, cleaning, fueling, boarding, pushback. Dependencies: baggage unload → load; alighting → cleaning; fueling often overlaps boarding with safety constraints.
- **In-block / off-block**: arrival at stand / departure from stand. **SLA**: planned duration per task; **buffer**: slack between planned task end and departure.
- Ground units referenced: baggage tractor + loader, catering truck, fuel hydrant dispenser, cleaning crew, pushback tug.

## 7. References

- Requirement source: `docs/00-context/target-roles.md` §1 (CAG Senior SWE Req 7075) — feature map in `traceability-matrix.md`.
- Data rules: `docs/02-standards/data-ethics.md`. UI rules: `ui-design-system.md`.
