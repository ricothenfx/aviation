# ADR-0009: Defer the "Weather Hold" Disruption Script (turnaround-iq)

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-09-24 |
| Supersedes | — |
| Related | PRD.md §3 F-5, milestones.md §F3, D-02, D-05, disruptions.ts (`DISRUPTION_CATALOG`) |

## Context

PRD F-5 lists four scripted disruption scenarios: loader breakdown, gate swap,
crew no-show, and **weather hold**. Milestone F3 scoped the disruption-injection
deliverable to **three scripts**, and the shipped catalog implements exactly
those three (`DISRUPTION_CATALOG`: `loader-breakdown`, `gate-swap`,
`crew-no-show`). The discrepancy surfaced in the F5 UI review (2026-09-24,
supervisor board first-view): the scenario console renders three injection
buttons. Per the truth hierarchy and handoff protocol (AGENTS.md §2/§3), the
conflict is reported and resolved by decision instead of a silent scope change.

The three shipped scripts cover the demo and DoD needs end-to-end: the loader
breakdown is the canonical 47 → ≤ 9 min replan benchmark (F3 DoD,
`pnpm bench:replan`), and gate swap plus crew no-show exercise alternate
constraint shapes (stand conflict, unit absence).

## Decision

Defer the `weather-hold` script. The scenario catalog stays at three entries;
PRD F-5's scenario list is interpreted as "including at least: loader
breakdown, gate swap, crew no-show", with weather hold as a documented
post-F5 candidate. It is **not** built silently in a polish pass: a weather hold
is a whole-bank disturbance (multi-flight arrival hold), so it would need its
own amendment/replan semantics, benchmark expectations, and tests — feature
work requiring a fresh milestone assignment from the user (D-05).

## Alternatives considered

1. **Build weather hold now** — exceeds "fix" scope, expands the simulator and
   replan engine without a milestone assignment; rejected.
2. **Treat the PRD list as a bug and edit it down** — silently rewriting an
   approved PRD without an ADR violates the drift-control rules; rejected.
3. **Ship a placeholder button** that injects a generic delay — a fake control
   in a demo product is dishonest (D-07); rejected.

## Consequences

- (+) Docs and code agree through an explicit, traceable decision; UI review
  findings are resolved honestly instead of papered over.
- (+) Scope discipline (AGENTS.md §3) is preserved — no unplanned feature work.
- (−) PRD F-5's literal four-scenario list is not fully implemented until a
  follow-up milestone adds `weather-hold`; traceability-matrix row F-5 should
  note the deferral.
- (−) Demo narrative loses one optional disruption flavor (weather hold) that
  was never part of any DoD gate.
