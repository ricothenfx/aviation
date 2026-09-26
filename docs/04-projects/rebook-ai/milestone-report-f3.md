# Milestone Report — rebook-ai F3 (Agentic Rebooking & Saga Fulfillment)

Status: **complete** · Date: 2026-09-26 · Stack: compose profile `rebook` (web :3004, orchestrator :4104)

## What shipped (scope per milestones.md F3, in order)

1. **Propose-only agent loop** (PRD F-5, architecture.md §3.3, ADR-0003/D-10):
   `services/rebook-ai/orchestrator/src/domain/agent-loop.ts` — a bounded,
   Bedrock-AgentCore-shaped tool loop over READ-ONLY tools
   (`search_routings` incl. interline partners → `price_itinerary` →
   `check_policy` → `draft_proposal`) evaluating the offer's ranked options
   against the committed inventory/policy fixtures. Deterministic pick
   (earliest arrival → fare delta → flight no) with policy gates surfaced;
   `proposalHash` (sha256 over canonical fields, timing excluded). Provider
   mock ⇒ `source: "llm"` + grounded mock-drafted rationale; provider off ⇒
   identical decision labeled `source: "rules"`, provider `rules-engine`.
2. **Proposal persistence + request path** (api-contracts.md §1): the web app
   enqueues `proposal.request` over `chan:rb:control` + `rb:result:*` (D-11
   pattern, browser never reaches the orchestrator); the loop output lands in
   `proposals` (trace JSONB `{rationale, toolCalls[]}`, tokens) + a
   `proposal.created` event + metrics. REST: `POST
   /api/v1/pnr/{locator}/proposal` (agent+, Idempotency-Key honored, poll via
   GET), `GET /api/v1/proposals/{id}` (trace + badges + supervisor gate).
3. **Proposal review** (PRD F-7 RBAC, architecture.md §3.3): approve/reject
   routes with `PROPOSAL_NOT_PENDING` (409) / elevation (interline or
   over-cap ⇒ supervisor only, 403 for agents) / mandatory reject note —
   approve applies through the ONE confirmation → saga path (no side door),
   reject mutates nothing else. Audit rows + `proposal.approved` /
   `proposal.rejected` events in the same transaction.
4. **Fulfillment saga executor** (PRD F-6, ADR-0014 §4):
   `domain/saga.ts` — seat_reserve → payment → ticket_issue; every step's
   effect and its `done` transition commit in ONE transaction keyed by the
   step's unique idempotency key (duplicate delivery ⇒ exactly one effect).
   Deterministic simulated stubs: seat_reserve decrements the DB seats-left
   counter (SEAT_UNAVAILABLE when short), payment fails on the injected
   `simulateFailure` marker (PSP_DECLINED), ticket_issue issues the boarding
   pass (deterministic `BP-…` ref + rebooked segment rows + `booking.issued`
   in the step transaction). Failure ⇒ reverse compensation (seat release,
   refund, ticket void recorded on the step rows), offer honestly reopened
   `proposed`, passenger returns to the queue (rebuild, new `compensation`
   frame reason). Transient errors retry (backoff + jitter) per
   architecture.md §6.
5. **Crash-safe resume** (architecture.md §6): startup recovery + a 30 s
   sweep re-drive `running`/`failed` sagas from persisted step state — a kill
   mid-saga finishes or compensates, never zombies. Confirms drive sagas via
   the tail (`offer.confirmed` → `advanceSaga`, idempotent).
6. **Boarding-pass demo beat** (demo-script.md): completed sagas carry
   `boardingPass {ref, newFlightNo}` (additive in `sagaViewSchema`); the
   passenger trip renders it with the ticket stub label.
7. **Agent console proposal cards** (PRD F-5 UI): request button, tool trace
   (per-call duration/tokens, inputs/outputs), `source`/`provider` honesty
   badges, supervisor-gate callout, approve/reject with note, saga link; the
   "Open proposals" tile is live from PG (`openProposals`, additive).
8. **Queue served-rule F3 alignment**: a PNR has left the queue iff its
   LATEST saga is `running`/`completed` (web + orchestrator mirrored) — a
   compensated saga re-queues the passenger honestly and never counts toward
   self-serve containment.
9. **Metrics** (architecture.md §7, F5-ready): saga step counters
   (completed/failed/compensated), saga outcome counters, proposal counters
   by source on `/metrics`.

## DoD checklist (milestones.md F3) — evidence

| DoD item | Evidence |
|---|---|
| Agent-loop determinism with mock provider: same inputs ⇒ same proposal (hash assert) in < 15 s (CI test) | `services/rebook-ai/orchestrator/src/domain/agent-loop.test.ts` — identical `proposalHash`/rationale/pick across runs, elapsed < 15 s asserted; runs in the CI unit lane (`pnpm test`, no DB). |
| Tool trace completeness: every proposal persists each tool call + inputs/outputs + token usage | Trace schema `proposalToolCallSchema` (contracts, F3 block in `packages/contracts/test/contracts.test.ts`); integration: `apps/rebook-ai/tests-integration/proposals.test.ts` asserts ordered tool calls, non-empty inputs/outputs per call, tokens > 0, persisted in `proposals.trace`. |
| Propose-only invariant: `proposal.created` triggers zero booking mutations; only approve applies via the saga path (integration test) | `proposals.test.ts` ("mutates no booking state"): confirmations/sagas/rebooked-segment counts unchanged after creation; the gate test shows effects appearing only after approve (1 confirmation, 1 saga, 3 steps). |
| RBAC: interline/over-cap approve requires supervisor (403 test for agent) | `proposals.test.ts` ("gates supervisor elevation"): agent approve ⇒ 403 `FORBIDDEN`, supervisor ⇒ 201 via the saga path; passenger/anon request ⇒ 403/401. |
| Saga idempotency: duplicate step delivery + duplicate confirm key ⇒ exactly one effect (CI test) | `services/rebook-ai/orchestrator/tests-integration/saga.test.ts` — double `advanceSaga` ⇒ seats decremented once, exactly one `booking.issued`; confirm-key replay covered by F2's `confirm.test.ts` (re-runnable, green this run). |
| Saga compensation: injected payment failure ⇒ reverse compensation completes, passenger returns to queue honestly (integration test) | `saga.test.ts` — PSP_DECLINED marker ⇒ seat_reserve `compensated` (seats restored), payment `failed`, saga `compensated`, `saga.compensated`+`saga.failed` events, offer reopened `proposed`, PNR present again in `loadDisruptedPnrs`. |
| Crash-safe resume: kill orchestrator mid-saga ⇒ restart finishes/compensates from persisted step state (integration test) | `saga.test.ts` — saga parked with seat_reserve `done` + seats decremented ⇒ `recoverUnfinishedSagas` completes it; done step NOT re-applied (seats decremented exactly once) + one `booking.issued`. Wired in production via boot recovery + 30 s sweep (`index.ts`). |
| Degrade honesty: provider off ⇒ proposals labeled `source: "rules"` end-to-end; provider mock ⇒ `llm`/`mock` badges (tests) | Provider off end-to-end: `orchestrator/tests-integration/proposal-rules.test.ts` (gateway null ⇒ persisted rules/rules-engine/0 tokens + `proposal.created` `source: "rules"`, then GET via the web API returns the same badges). Mock: `proposals.test.ts` asserts `llm`/`mock` through the API; unit tests cover both modes at the loop level. |
| Audit completeness: approve/reject/confirm each append an audit row (test) | `proposals.test.ts` — `proposal.approved` + `offer.confirmed` (via the shared path) and `proposal.rejected` audit rows asserted; confirm row covered by F2 `confirm.test.ts`. |
| E2E (Playwright): agent login → request proposal → inspect trace → approve → saga completes → boarding pass visible | `apps/rebook-ai/e2e/agent-flow.spec.ts` (`pnpm test:e2e:rebook`): agent requests + inspects trace/badges, supervisor approves (network-observed 201), passenger trip shows `BP-…` boarding pass + `ticket_issue: done`. Re-run convention documented in the spec header. |

## Full gates (this run)

- `pnpm lint` ✓ (prettier + eslint, 0 problems) · `pnpm typecheck` ✓ (strict,
  0 errors) · `pnpm test` ✓ (unit lanes: contracts 28, app 7, orchestrator 26).
- `pnpm build` ✓ (packages + apps).
- `pnpm --filter rebook-ai test:integration` ✓ 27/27 ·
  `pnpm --filter @aviation/rb-orchestrator test:integration` ✓ 8/8 — both
  re-runnable; final run executed on a fresh stack (see below).
- E2E `pnpm test:e2e:rebook` ✓ twice from cold `down -v` boots (agent flow +
  F2 passenger flow; the RBAC-gate spec skips by design once the journey
  offer is confirmed — documented F2 behavior).
- `pnpm bench:rebook` 3 runs, min 333 / median 620 / **p95 1270** ms
  (< 10 s gate) and `pnpm bench:rebook-queue` 20 runs, min 132 / median 266 /
  **p95 375** ms (< 1 s gate) on the fresh stack — no F2 regression.

## Document sections relied on (AGENTS.md §3)

- **milestones.md** F3 scope + DoD + Handoff Protocol.
- **architecture.md** §1–2 (web/orchestrator split), §3.2 (confirm → saga
  fulfillment, compensation, booking.issued after the final step), §3.3
  (AgentCore-shaped tool loop, bounded/traced/propose-only, approval through
  the same saga path, supervisor gate), §4 (control/result pattern),
  §6 (retries → deterministic compensation, crash-safe re-drive, no zombies),
  §7 (metrics).
- **api-contracts.md** §1 (proposal/compensate REST rows), §2 (event
  vocabulary: `proposal.*`, `saga.*`, `booking.issued` — unchanged),
  §3 (live frames — one additive `reason` value), §5 (proposal inertness,
  degrade honesty, audit completeness).
- **data-model.md** §2 (proposals trace, saga step stubs, additive
  `inventory_seats`/`decided_at` notes), §3 (rebuildable projections).
- **PRD.md** F-5 (propose-only, trace, degrade badges), F-6 (idempotent
  compensable saga, honest queue return), F-7 (RBAC ladder + audit); §4 OUT
  OF SCOPE respected (no real PSP, no autonomous execution).
- **AGENTS.md** §3 (quality gates, honesty, scope), **data-ethics.md** §2
  (simulated PSP/inventory labeling), **tech-stack.md** §3 (no new
  dependencies), D-10/D-11/D-14/D-20/D-21, ADR-0003/ADR-0014.

## Additions & deviations (Handoff Protocol §2 — docs updated to match)

All additive; no spec behavior reinterpreted.

1. **`inventory_seats` table + migration `0002`** (data-model.md §2 note
   added): the F2 handoff explicitly deferred "seats-left accounting" to the
   F3 saga's seat_reserve step. The fixture stays the ranking input (F2 DoD
   determinism untouched); the table is the countable, crash-safe fulfillment
   ledger that makes "exactly one effect" testable and gives the demo a
   reachable SEAT_UNAVAILABLE → compensation path.
2. **`proposals.decided_at` column** (same migration; data-model.md note):
   approve/reject timestamp for decision-latency evidence (PRD F-5).
3. **`queue.delta` reason value `compensation`** (additive enum extension,
   api-contracts.md §3's frame types unchanged): compensation is a queue
   event; clients resync from REST regardless.
4. **`openProposals` on `queueSnapshotViewSchema`** and **`boardingPass` on
   `sagaViewSchema`**, **`offerId` nullable on `proposalViewSchema`**
   (additive view fields; the F2 queue console's hard-coded "0 proposals"
   tile becomes live).
5. **Proposal route targets the newest *proposed* offer** (api-contracts.md
   §1 wording "Request an agent-loop proposal" made precise): a PNR may hold
   several historic offers; the loop always works on the open one.

## Known limits / F4 handoff notes

- The saga stubs are deterministic single-shot simulations: no queued
  back-pressure model, no partial authorization; the retry path (transient
  errors) is exercised only by unit-level timing, not by an injected flaky
  dependency (F5 load evidence may add one).
- Proposal approval reuses the offer's TTL: an approval arriving after offer
  expiry returns `OFFER_EXPIRED` (the proposal stays `proposed`) — the
  console surfaces the error honestly; auto-invalidating expired proposals
  is left to F4 polish.
- `advanceSaga` is serialized per service instance (tail reentrancy guard);
  multi-instance deployment would need per-saga leases (documented ADR-0014
  scale ceiling, revisit via new ADR if ever needed).
- `pnpm test:e2e:rebook` still expects a fresh stack for the full
  click-through; re-runs verify completed states (documented in both specs).
