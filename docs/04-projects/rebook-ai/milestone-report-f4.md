# Milestone Report — rebook-ai F4 (Passenger Experience & Console Polish)

Status: **complete** · Date: 2026-09-27 · Stack: compose profile `rebook` (web :3004, orchestrator :4104)

## Pre-task: flaky rebook CI lane (blocker fix, user-assigned)

- **Symptom:** the `rebook.yml` lane failed on both **349139c (F2)** and **7537063 (F3)**
  at "Integration tests": `scenario-offers.test.ts` asserted
  `summary.disruption` with a single-shot GET. The inject route appends
  `flight.disrupted` and returns 201; `getDisruptionForPnr`
  (`apps/rebook-ai/src/lib/data/views.ts`) only sees the disruption once the
  orchestrator event tail flips `flights.status` — a race the slower CI runner
  lost (locally it passed).
- **Fix (00d18dd):** poll `/api/v1/pax/summary` until `disruption !== null`
  (bounded 10 s, honest failure after it) mirroring the suite's existing
  `pollOffers` pattern; the test also calls `ensureDisrupted` first to stay
  order-independent.
- **Verification:** rebook lane **green on 00d18dd** (run
  [36279144057](https://github.com/ricothenfx/aviation/actions/runs/36279144057),
  2 m20 s, compose smoke + both integration lanes).
- **Honesty note (Handoff Protocol §2):** F2 and F3 were reported complete while
  this lane was red on their commits. Their reports evidenced **local** gates
  (accurate as far as they went) and F2's E2E row says "green locally", but
  neither run verified the GitHub lane after push, so the milestone-level "CI
  non-negotiable" gate (AGENTS.md §3) was not actually met on `origin/main`
  between 349139c and 00d18dd. Recorded here so the gap is on the record; the
  lane is green again as of this milestone.

## What shipped (scope per milestones.md F4, in order)

1. **Passenger journey timeline** (`src/components/trip-timeline.tsx`):
   disruption → rebooking options → decision → fulfillment → new itinerary,
   derived read-side from the pax summary (no new state, no contract change);
   stage color always paired with a text label (§2), calm accent for the active
   stage (§6), timestamps from the domain events.
2. **Voucher wallet** (PRD F-3): amount-first voucher cards with issued time,
   state badge, dashed-stub styling and the explainability criteria trail
   (rule + met flag + evaluated detail); per-card "Simulated voucher" label
   (data-ethics.md §2).
3. **Notification inbox UX** (PRD F-1): subject + body + relative time, channel
   and delivery-state badges (`queued/delivered/failed` — honest simulated
   delivery), newest-first emphasis.
4. **ARIA live region** (ui-design-system §9): a `role="status" aria-live="polite"`
   region announces incoming disruption/notification transitions (diffed against
   the previous snapshot, announces once).
5. **Agent console design pass** (PRD F-4): the three KPI tiles moved to the
   shared `StatTile` with **count-up on change** (§6, `useCountUp`, reduced-motion
   aware; "—" never animates a fake number, D-15); queue rows are a keyboard-
   navigable disclosure list — roving ArrowUp/ArrowDown focus, `aria-expanded` +
   `aria-controls`, visible focus ring; proposal decision cards got a labeled
   note input (`Label htmlFor`).
6. **Supervisor audit trail view** (PRD F-7, demo-script beat 80–90 s):
   additive `GET /api/v1/admin/audit` (`auditTrailViewSchema` in contracts) over
   the append-only `audit_events`, enriched read-side with the actor email and
   the PNR locator (offer/proposal/saga → PNR batch resolution) so the trail
   answers "who decided what for whom, when"; `AuditTrailPanel` on the
   supervisor console with table headers, loading/empty/error states and a 5 s
   poll.
7. **Design-system polish** (§6/§7): skeletons match the final layout on trip +
   console; live data keeps the fade+slide entrance; `border-l-red-500` raw
   Tailwind replaced by the semantic `border-l-danger` token; confirm-error
   panel now `role="alert"`.
8. **Self-serve containment tile** (PRD §5): live from PG with an explicit
   "not measurable — no disruption active" empty value.

## DoD checklist (milestones.md F4) — evidence

| DoD item | Evidence |
|---|---|
| UI review checklist (§5 archetypes adapted, §7 states, §8 forbidden patterns) passes — screenshots in report | 10 screenshots captured by `apps/rebook-ai/scripts/capture-ui-review.mjs` in [demo-run-f4.md](demo-run-f4.md): supervisor console with all three panels (f4-01), passenger trip stages (f4-02/03/06), agent console queue + decision card (f4-04/05), audit trail (f4-07), containment (f4-08), keyboard focus (f4-09), tablet (f4-10). Loading/empty/error/live states: loading skeletons (trip/queue/audit), empty audit trail + empty inbox/voucher states visible in the shots, error + retry via `ErrorState` (unchanged F1 surfaces), live via `LiveDot` + "updated Ns ago". |
| No forbidden patterns (§8) — explicit self-check | (1) No framework-default look — all surfaces on the `@aviation/ui` token kit; (2) no purple-magenta gradients, glassmorphism, emoji icons or sparkles; (3) no lorem ipsum / "John Doe" — cast is the seeded NX/SV/BH fixture, airlines match flight numbers; (4) no charts without labels (no charts added); the queue table keeps its header row; (5) no layout shift on live updates (updates swap text in fixed grids; count-up eases in place), no scroll-jacking, no un-dismissable modals (errors are inline `role="alert"` panels); (6) responsive verified at 1280×720 and 768×1024 (f4-10); (7) only fictional carriers (NX/SV/BH) + "Simulated data" footer everywhere. |
| Passenger journey e2e: disruption → inbox + voucher (when criteria met) → confirm → new boarding pass, all labeled simulated | `apps/rebook-ai/e2e/passenger-flow.spec.ts` (extended F2 spec): asserts the timeline, inbox item with "simulated delivery", voucher card with met criteria + "Simulated voucher" label, one-tap confirm, live saga steps, boarding pass `BP-…` labeled simulated, and the footer disclaimer. Green on a fresh stack (re-run tolerance documented in the spec header). |
| Keyboard-navigable primary flows; visible focus; ARIA live region | Queue rows: buttons with roving ArrowUp/ArrowDown + Enter/Space, `aria-expanded`/`aria-controls` (queue-panel.tsx); offer confirm/agent console actions are native buttons; global `:focus-visible` outline (globals.css); live region announces disruption/notification (trip-panel.tsx); evidence shot f4-09. |
| Responsive: usable at 1280×720 and tablet width (visual smoke) | All shots captured at 1280×720; f4-10 is the passenger trip at 768×1024 — the timeline collapses to a vertical list, offer cards stack, queue table scrolls horizontally (`overflow-x-auto` + `min-w`). |
| All PRD in-scope features F-1…F-7 demonstrable in one continuous run | [demo-run-f4.md](demo-run-f4.md) — the harness walked inject → offers/voucher/inbox (F-1/F-2/F-3) → interline gate (F-7) → traced proposal (F-5) → approval via the ONE saga path → boarding pass (F-6) → audited compensation on a second PNR (NXH7ZL returned to the queue) → containment tile + audit trail (F-4/F-7), reading every number from the running stack. |

## Full gates (this run)

- `pnpm lint` ✓ (prettier + eslint 0 problems) · `pnpm typecheck` ✓ (strict,
  0 errors) · `pnpm test` ✓ (unit lanes: contracts **29** incl. the new
  audit-view schema test, app 7, orchestrator 26; workspace total 179 across
  9 packages) · `pnpm build` ✓ (packages + apps; the in-container `next build`
  also caught and I fixed a rules-of-hooks violation before push).
- `pnpm --filter rebook-ai test:integration` ✓ **30/30** (8 files, incl. the new
  `audit.test.ts`) · `pnpm --filter @aviation/rb-orchestrator test:integration`
  ✓ **8/8**.
- `pnpm test:e2e:rebook` ✓ on a cold `down -v` stack: agent-flow full
  click-through + F4 passenger journey (RBAC-gate spec skips by design once the
  journey offer is confirmed — documented F2 behavior).
- `pnpm bench:rebook` **p95 603 ms** (gate < 10 s) and `pnpm bench:rebook-queue`
  **p95 716 ms** (gate < 1 s) — no F2/F3 regression.
- CI: `rebook.yml` **green** on 00d18dd (pre-task fix); this milestone's push
  re-runs the same lane on the F4 commit.

## Document sections relied on (AGENTS.md §3)

- **milestones.md** F4 scope + DoD + Handoff Protocol.
- **PRD.md** F-1…F-7 acceptance highlights (inbox seconds after disruption,
  per-rank reasons, explainable voucher, live shrinking queue + containment,
  propose-only agent with trace, saga honesty, audit trail); §4 OUT OF SCOPE
  respected (no real PSP/email/push, no i18n, no registration).
- **ui-design-system.md** §2 tokens-only colors, §3 typography/spacing, §6
  motion (count-up on KPI change, fade+slide, reduced-motion), §7 mandatory
  states, §8 forbidden patterns, §9 keyboard/focus/ARIA.
- **api-contracts.md** §1 (one additive supervisor row), §5 behavioral
  contracts (audit completeness wording drove the view's "who/what/for whom/
  when" columns).
- **data-model.md** §2 (`audit_events` append-only, INSERT-only trigger — the
  view is read-side only, no schema change).
- **demo-script.md** beat sheet (the continuous run mirrors it, including the
  80–90 s audit beat the F3 build could not yet demonstrate).
- **data-ethics.md** §2/§4 (simulated labels on voucher/inbox/boarding pass;
  all run numbers read from the stack).
- AGENTS.md §3 (quality gates, honesty, scope), D-09/D-10/D-11/D-14/D-15/D-20/
  D-21, ADR-0003/ADR-0014/ADR-0015.

## Additions & deviations (Handoff Protocol §2 — docs updated to match)

All additive; no spec behavior reinterpreted.

1. **`GET /api/v1/admin/audit?limit=` + `auditTrailViewSchema`/
   `auditEntryViewSchema`** (api-contracts.md §1 row added): the F4 DoD "all
   F-1…F-7 flows demonstrable in one continuous run" includes PRD F-7's audit
   trail, and demo-script beat 80–90 s explicitly names an "audit trail view" —
   F3 shipped the rows but no surface. Read-side enrichment only; no write-path
   or schema change.
2. **`StatTile.testId` prop** (packages/ui, additive): stable e2e hook for the
   console KPI tiles, previously hand-rolled `<div data-testid>` elements.
3. **Test-fixture repair, `confirm.test.ts`** : `ensureFixtureOffer` set
   `expires_at` only at creation, so re-runs more than 30 minutes after the
   first provisioning failed with 409 `OFFER_EXPIRED` (found while re-running
   the suite during F4 — same flaky-family as the lane fix). The reset now
   refreshes the TTL (the `expired` scenario stays honestly in the past),
   restoring the documented re-runnability. No product code touched.
4. **`apps/rebook-ai/scripts/capture-ui-review.mjs`**: committed harness that
   produces the continuous-run evidence (screenshots + beat log); manual, not
   part of the e2e lane (it consumes the demo disruption by design).

## Known limits / F5 handoff notes

- The audit view resolves locators read-side for the latest `limit` rows only;
  scenario-level rows (`scenario.injected`, flight target) legitimately show
  "—". No pagination beyond `limit` clamp 1–200 (sufficient for the demo day;
  revisit with the traceability work if F5 needs deeper history).
- Containment in the demo run reads 0% at the captured moment: the reference
  run serves NXQ4ZK via the agent/supervisor path (interline) and the honesty
  PNR was compensated, so no passenger-role self-serve confirm had landed yet.
  The metric is honest by design (D-07); a pure-self-serve beat (same-carrier
  confirm as the passenger) raises it — the F5 demo video can choose either.
- The compensation beat in the harness retries candidates in queue order
  because a manual compensate can lose the race against the ~1 s executor
  (409 `SAGA_CONFLICT` on a completed saga). Deterministic compensation via an
  injected step failure remains orchestrator-internal (`simulateFailure`), as
  the F3 handoff noted; F5 load evidence may still add a flaky dependency.
- `buildPaxSummary` returns the newest 2 offers per PNR; stacks where
  integration fixtures were provisioned for NXQ4ZK *before* the e2e run shadow
  the confirmed offer on /trip (agent-flow's re-run branch then finds no
  boarding pass). The documented convention — e2e on a fresh stack — avoids
  this; noted here because it cost one local re-run during F4.
