# Rebook.ai — Milestones

| Field | Value |
|---|---|
| Status | Approved — execution order binding (D-05; user kickoff 2026-09-26 covers F0+F1 in one run) |
| Rule | One milestone per agent run (F0/F1 combined per explicit user kickoff). DoD evidence linked in the milestone report. No jumping ahead. |

## F0 — Documentation (DONE 2026-09-26)

Full PRD, architecture, data-model, api-contracts, milestones, demo-script authored from
the 2026-09-22 skeleton's "TODO at spec time"; ADR-0014 (orchestrator topology + saga) and
ADR-0015 (PostgreSQL JSONB store — honest evaluation per the skeleton's mandate) +
decision-log D-20/D-21. ✅

## F1 — Scaffold & Skeleton

**Scope:** `apps/rebook-ai` (Next.js :3004) + `services/rebook-ai/orchestrator` (TS worker
:4104) per ADR-0014; compose profile `rebook` (shared postgres, database `rebook_ai`,
redis); rebook event vocabulary + payloads added to `packages/contracts` additively;
auth module per D-09 (seeded users, roles `passenger/agent/supervisor`); app shells for
both surfaces (passenger home + agent console) with all mandatory states (ui-design-system
§7) and simulated-data footer; orchestrator `/healthz` `/readyz` `/metrics` with provider
dependency check via the mock gateway (ADR-0003); path-filtered CI (`rebook.yml`);
`seed:rebook` (ensure DB → migrate → upsert users).

**DoD:**
- [ ] Clean clone: `pnpm install && docker compose --profile rebook up -d` serves web :3004 healthy + orchestrator :4104 healthy (README-documented from-scratch run)
- [ ] CI green: lint + typecheck + unit + build (zero warnings, strict TS) via path-filtered `rebook.yml`
- [ ] Login as a seeded user per role works; role ladder enforced server-side (RBAC test matrix passenger/agent/supervisor)
- [ ] Migration test: `rebook_ai` DB created idempotently; `users` table + argon2 hashes present after `pnpm seed:rebook`
- [ ] Contract test: every rebook event type validates against its typed zod schema; envelope invariants hold (uuid aggregate, monotonic sequence)
- [ ] `/healthz` + `/readyz` on both services; orchestrator readyz reports db, redis, provider; web readyz reports db, provider
- [ ] Passenger home + agent console shells render loading/empty/error states from real fetches (not hard-coded), with the simulated-data footer visible
- [ ] ADR compliance: no library outside tech-stack.md

## F2 — Schedule, Disruption & Offers (core domain)

**Scope:** full schema slice (flights, pnr, segments, offers, options, notifications,
vouchers, event_log, audit, idempotency — data-model.md §1/§2); reference-day seed
(schedule + ~40 PNRs + inventory + policy); scenario injection (cancellation/long-delay)
via supervisor console; offer ranking engine (fast/cheap/flexible with per-rank reasons +
policy caps); voucher rule engine (explainable criteria); notification publisher
(SNS-shaped, in-app inbox, simulated delivery); live queue projections (Redis) + live
updates (SSE/ws per api-contracts §3); passenger offer view + one-tap confirm (idempotent);
agent queue console v1 (live, priority-sorted, containment metric).

**DoD:**
- [ ] Reference scenario: injection → notification + ranked offers visible p95 < 10 s on the scenario clock (measured, logged)
- [ ] Ranking determinism: same disruption + inventory snapshot ⇒ identical ranked offer set (hash assert, CI test)
- [ ] Voucher explainability: every issued voucher persists rule inputs + evaluated values; test covers meet/not-meet cases
- [ ] Confirm idempotency + expiry tests (`OFFER_EXPIRED`, `IDEMPOTENCY_CONFLICT`) per api-contracts §5
- [ ] Queue live update < 1 s p95 after event append (benchmark logged); queue rebuild-from-PG test (Redis flush ⇒ identical snapshot)
- [ ] Contract tests: REST payloads + live frames validate against zod; RBAC matrix incl. ownership scoping (passenger cannot read another PNR's offers)
- [ ] Poison event surfaced (supervisor view) with honest `processed=false` + error note — never silently dropped
- [ ] E2E (Playwright): passenger login → disruption → notification → confirm option → saga state visible (stub saga steps)

## F3 — Agentic Rebooking & Saga Fulfillment

**Scope:** agent loop over `packages/llm-gateway` (tools: `search_routings` incl. interline
partners, `price_itinerary`, `check_policy`; bounded rounds, traced, propose-only — PRD
F-5); proposal review (approve/reject + note, interline/over-cap supervisor gate);
fulfillment saga executor (seat-reserve → payment → ticket-issue) with compensation +
crash-safe resume; boarding-pass issuance (demo beat); agent console proposal cards with
tool trace + `source`/`provider` honesty badges (degrade-to-rules, D-10).

**DoD:**
- [ ] Agent-loop determinism with mock provider: same inputs ⇒ same proposal (hash assert) in < 15 s (CI test)
- [ ] Tool trace completeness: every proposal persists each tool call + inputs/outputs + token usage
- [ ] Propose-only invariant: `proposal.created` triggers zero booking mutations; only approve applies via the saga path (integration test)
- [ ] RBAC: interline/over-cap approve requires supervisor (403 test for agent)
- [ ] Saga idempotency: duplicate step delivery + duplicate confirm key ⇒ exactly one effect (CI test)
- [ ] Saga compensation: injected payment failure ⇒ reverse compensation completes, passenger returns to queue honestly (integration test)
- [ ] Crash-safe resume: kill orchestrator mid-saga ⇒ restart finishes/compensates from persisted step state (integration test)
- [ ] Degrade honesty: provider off ⇒ proposals labeled `source: "rules"` end-to-end; provider mock ⇒ `llm`/`mock` badges (tests)
- [ ] Audit completeness: approve/reject/confirm each append an audit row (test)
- [ ] E2E (Playwright): agent login → request proposal → inspect trace → approve → saga completes → boarding pass visible

## F4 — Passenger Experience & Console Polish

**Scope:** passenger timeline (disruption → offers → decision → new itinerary), voucher
wallet, notification inbox UX; agent console design pass (queue density, decision cards,
keyboard nav); design-system polish per ui-design-system.md (tokens, motion §6, states
§7); all PRD F-1…F-7 flows demonstrable in one continuous run; self-serve containment
metric tile.

**DoD:**
- [ ] UI review checklist (ui-design-system §5 archetypes adapted, §7 states, §8 forbidden patterns) passes — screenshots in report
- [ ] No forbidden patterns (§8) — explicit self-check in the report
- [ ] Passenger journey e2e: disruption → inbox + voucher (when criteria met) → confirm → new boarding pass, all labeled simulated
- [ ] Keyboard-navigable primary flows; visible focus; ARIA live region for incoming disruption/notification
- [ ] Responsive: usable at 1280×720 and tablet width (visual smoke)
- [ ] All PRD in-scope features F-1…F-7 demonstrable in one continuous run

## F5 — Evidence & Ship

**Scope:** k6 load evidence (offer pipeline at ×10 scale; confirm/saga concurrency with
zero double-effects); README landing (problem→solution, two-sided architecture diagram,
JD mapping table for SIA/Amadeus/SITA/CAG-Commercial rows, "what is simulated" section);
live demo deploy mirroring D-12 topology; 90 s demo video per demo-script.md;
traceability-matrix §3 populated; market-research §5 re-verification.

**DoD:**
- [ ] Load report (honest, committed): offer pipeline p95 < 10 s at ×10 disruption scale; N-way confirm concurrency with exactly-one-effect verified — degradations documented
- [ ] Final re-run of F2/F3 CI gates at final fixture versions
- [ ] README complete: double-audience narrative, ADR-linked trade-off story (orchestrator-not-queue-product, JSONB-not-MongoDB per ADR-0015, propose-only agent)
- [ ] Live demo URL serving `/healthz` + seeded logins + one full demo beat; fresh 90 s video (demo-script.md)
- [ ] `docs/00-context/traceability-matrix.md` §3: every row has feature, code path, tests (usage protocol §3)
- [ ] `docs/00-context/market-research.md` §5 re-verified; snapshot date updated

## Handoff Protocol (every milestone)

1. Milestone report: what shipped, DoD checklist with evidence links, doc sections relied upon (AGENTS.md §3).
2. Deviations: any spec mismatch found → STOP, report, propose doc fix. Docs win over code until the user says otherwise.
3. Next milestone starts only on the user's go.
4. Commit and push every completed step/milestone to `origin/main` (conventional commits, `rebook` scope) — standing instruction per turnaround-iq/mro-copilot precedent.
