# TurnaroundIQ — Milestones

| Field | Value |
|---|---|
| Status | Approved — execution order binding (D-05) |
| Rule | One milestone per agent run. DoD evidence linked in the milestone report. No jumping ahead. |

## F0 — Documentation (DONE 2026-09-22)
Docs tree in this repo; PRD/architecture/data-model/contracts approved. ✅

## F1 — Scaffold & Skeleton
**Scope:** monorepo scaffold per ADR-0004; `packages/{ui,contracts,config,db,llm-gateway}` initialized; turnaround-iq app boots with design tokens; compose profile `turnaround` (postgres+redis+web); auth module with seeded users + login; CI pipeline (lint/typecheck/unit/build); `pnpm seed` skeleton loads reference day.
**DoD:**
- [ ] `pnpm install && docker compose --profile turnaround up -d && pnpm dev` works from clean clone (README documented)
- [ ] CI green: lint + typecheck + unit + build
- [ ] Login as seeded coordinator works; command board renders shell with all mandatory states (loading/empty/error/live) from ui-design-system §7
- [ ] `packages/contracts` compiles with event envelope + error schemas; consumers typecheck against it
- [ ] ADR compliance: no library outside tech-stack.md

## F2 — Core Domain: Events, Projections, Live Board
**Scope:** full schema + migrations (data-model.md); simulator with scenario clock producing deterministic events for the reference day; projection worker → Redis read models; realtime gateway broadcasting deltas; live Gantt board + flight drawer + event history; REST endpoints per contracts.
**DoD:**
- [ ] Reference scenario plays end-to-end: board updates < 1 s p95 after ingestion (measured, logged)
- [ ] Integration test: replay full seed event log → projections match golden state (ADR-0001 compliance test)
- [ ] Idempotency: duplicate delivery of any event is a no-op (test)
- [ ] Contract tests: ws + REST payloads validate against zod schemas
- [ ] RBAC enforced server-side for all endpoints (test matrix viewer/coordinator/supervisor)

## F3 — Risk Rules & Constraint Replan
**Scope:** risk rule engine (SLA-breach projection ≥ 10 min lead, PRD F-3) + alert lifecycle; constraint scheduler with dependencies/unit constraints/fuel-boarding overlap; replan propose → human approve/reject flow (PRD F-4); disruption injection (3 scripts) via scenario console (backend+API only; console UI polish is F4).
**DoD:**
- [ ] Reference scenario: alert leads breach by ≥ 10 min (asserted in integration test)
- [ ] Replan on "loader breakdown" script: total delay 47 → ≤ 9 min; computation < 2 s (benchmark test committed under `scripts/benchmarks/`)
- [ ] Infeasible case returns `REPLAN_INFEASIBLE` with conflict list (test)
- [ ] Determinism: same seed + log ⇒ identical plan hash (CI test)
- [ ] E2E (Playwright): seed → inject disruption → alert → replan → approve → board reflects new schedule

## F4 — Copilot & UI Polish
**Scope:** llm-gateway integration for plan explanation (mock provider default; degrade-to-rules labeled); scenario console UI; design-system polish of board/drawer per ui-design-system.md; all mandatory states; keyboard nav + ARIA live alerts; footer disclaimer; responsive to 1280×720.
**DoD:**
- [ ] Copilot explanation present on every proposal; `source` label correct with and without LLM provider (tests)
- [ ] UI review checklist (ui-design-system §5, §7, §8) passes — screenshots attached to report
- [ ] No forbidden patterns (§8) — explicit self-check in report
- [ ] Playwright: visual smoke of command board + drawer at 1280×720 and tablet width
- [ ] All PRD in-scope features F-1…F-7 demonstrable in one continuous run

## F5 — Evidence & Ship
**Scope:** k6 load test (×10 scenario scale, 200 concurrent consumers) + Grafana dashboard; README landing page (GIF, problem→solution, architecture diagram, "mapped to JD requirements" table); ADR finalization; demo video (demo-script.md); deploy live demo; traceability-matrix + market-research re-verification.
**DoD:**
- [ ] Load report: p95 ingestion→board < 1 s at 10× events; honest findings documented
- [ ] Live demo URL + fresh walkthrough video (90 s) published
- [ ] README complete (double-audience narrative); repo commit history conventional
- [ ] traceability-matrix.md fully populated for this project (all rows have code path + tests)
- [ ] market-research.md §5 re-verification run; snapshot date updated

## Handoff Protocol (every milestone)
1. Milestone report: what shipped, DoD checklist with evidence links, doc sections relied upon (AGENTS.md §3).
2. Deviations: any spec mismatch found → STOP, report, propose doc fix. Docs win over code until user says otherwise.
3. Next milestone starts only on user's go.
