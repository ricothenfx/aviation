# Milestone Report — rebook-ai F2 (Schedule, Disruption & Offers)

Status: **complete** · Date: 2026-09-26 · Stack: compose profile `rebook` (web :3004, orchestrator :4104)

## What shipped (scope per milestones.md F2, in order)

1. **Full schema slice** (data-model.md §1–§2): `flights`, `pnr` (+`user_id`,
   see additions), `pnr_segments`, `offers`, `offer_options`, `confirmations`,
   `sagas`, `saga_steps`, `vouchers`, `notifications`, `proposals` (F3 consumes),
   `event_log` (poison columns), `audit_events` (append-only trigger),
   `idempotency_keys` — migration `apps/rebook-ai/drizzle/0001_military_junta.sql`
   incl. the audit append-only trigger (mro-copilot precedent, data-model §2).
2. **Reference-day seed** (data-model.md §4/§6): committed fixtures
   `seed/reference-day.json` (120 flights, NX/SV/BH blocks + demo anchor
   NX 288), `seed/pnrs.json` (41 PNRs incl. demo cast, 14 on NX 288, families /
   gold tier / interline-eligible), `seed/inventory.json` (19 candidate segments
   incl. SV/BH partners), `seed/policy.json` (voucher criteria, tier fare caps,
   offer TTL). Generator kept at `scripts/seed-rebook/`; every PNR segment
   references a real scheduled flight with matching dest/departure
   (fixture-consistency check in the generator). Second demo passenger login
   `sofia.rossi@pax-sim.example` (PNR NXM8QT, NX 203) for E2E isolation.
3. **Scenario injection** (api-contracts.md §1, architecture.md §3.1):
   supervisor-only `POST /api/v1/scenario/inject` (Idempotency-Key aware) →
   appends `flight.disrupted`; supervisor console `/supervisor` with inject
   panel + poison-event view.
4. **Offer ranking engine** (PRD F-2): pure `rankOffers` in the orchestrator —
   fast/cheap/flexible with per-rank human reasons, tier fare caps (`overCap`
   flag), party-size vs seats, departure-not-before-original rule,
   `rankingHash` (sha256 over the canonical option list) persisted in
   `offers.context`.
5. **Explainable voucher rules** (PRD F-3): pure `evaluateVoucher` —
   cancellation / long-delay / tier-bonus / max-cap rules, every criterion
   persisted with inputs + evaluated values.
6. **SNS-shaped notification publisher** (PRD F-1): `PublishInput`-shaped
   interface, in-app inbox implementation (simulated delivery, honest
   `deliveredAt`), `notification.sent` events.
7. **Live queue projections** (PRD F-4, data-model.md §3): `rb:queue:agent`
   ZSET (priority = tier + kind + SSR + capped wait), rebuild-from-PG via
   `chan:rb:control` result keys, containment metric from PostgreSQL,
   `queue.delta`/`offers.update`/`saga.update` frames on `chan:rb:live`,
   SSE bridge `GET /api/v1/live` (passenger streams PNR-scoped).
8. **Passenger offer view + idempotent confirm** (api-contracts.md §1/§5):
   `GET /api/v1/pax/offers/{id}`, `POST .../confirm` — required
   Idempotency-Key, PG replay store (`idempotency_keys`, crash-safe),
   `OFFER_EXPIRED` / `IDEMPOTENCY_CONFLICT` / interline `FORBIDDEN`, saga +
   3 stub steps opened in the confirm transaction, audit row, `offer.confirmed`.
9. **Agent queue console v1** (PRD F-4): live SSE-driven queue with
   priority order, wait, offer state, containment tile, expandable PNR context
   (`GET /api/v1/pnr/{locator}`); passenger trip surface (offers with reasons +
   countdown, voucher criteria, inbox, saga panel, honest F3 note).

## DoD checklist (milestones.md F2) — evidence

| DoD item | Evidence |
|---|---|
| Reference scenario: injection → notification + ranked offers visible p95 < 10 s (measured, logged) | `pnpm bench:rebook` (fresh stack): 5 runs, min 671 / median 709 / **p95 980** / max 980 ms → **pass**. Single-shot < 10 s also asserted in `tests-integration/scenario-offers.test.ts`. |
| Ranking determinism: same disruption + inventory ⇒ identical ranked set (hash assert, CI test) | `services/rebook-ai/orchestrator/src/domain/ranking.test.ts` — hash equality + divergence on changed inventory; runs in CI (rebook.yml unit lane via `pnpm test`). |
| Voucher explainability tests (meet / not-meet) | `vouchers.test.ts` — cancellation met, long-delay below threshold, cap evaluation, no-base-rule case; criteria carry inputs + evaluated detail. |
| Confirm idempotency + expiry tests (`OFFER_EXPIRED`, `IDEMPOTENCY_CONFLICT`) | `tests-integration/confirm.test.ts` — missing key 400, same-key replay identical (`Idempotency-Replayed: true`), different key 409, expired 409 + no saga, interline passenger 403, agent path 201, saga stub steps + event + audit persisted. |
| Queue live update < 1 s p95 after event append (measured, logged) | `pnpm bench:rebook-queue`: 20 runs, min 122 / median 320 / **p95 632** / max 1048 ms → **pass** (after halving the tail poll to 150 ms; cold-start outlier documented). Single-shot < 1 s asserted in `tests-integration/queue.test.ts`. |
| Contract tests: REST payloads + live frames validate against zod | `packages/contracts/test/contracts.test.ts` (new F2 block: summary/offer/queue/inject/poison/frame schemas); integration suites parse live responses with `paxSummaryViewSchema` / `offerSetViewSchema` / `queueSnapshotViewSchema`; SSE bridge drops non-conforming frames. |
| RBAC matrix incl. ownership scoping (passenger cannot read another PNR's offers) | `tests-integration/scenario-offers.test.ts` (404 for foreign offer, agent 200), `queue.test.ts` (passenger 403), `poison.test.ts` (supervisor-only), inject matrix (anon 401 / pax 403 / agent 403). |
| Poison event surfaced (supervisor view) with honest processed=false + error note | `tests-integration/poison.test.ts` + `GET /api/v1/admin/events` (attempts cap 3 in the tail; supervisor console panel). |
| E2E: passenger login → disruption → notification → confirm option → saga state visible (stub saga steps) | `apps/rebook-ai/e2e/passenger-flow.spec.ts`, `pnpm test:e2e:rebook` — green locally; wired as `playwright-rebook` job in `.github/workflows/e2e.yml`. |

## Full gates (this run)

- `pnpm lint` ✓ (prettier + eslint, 0 problems) · `pnpm typecheck` ✓ (strict, 0 errors) ·
  `pnpm test` ✓ (171 unit tests across 9 packages) · `pnpm build` ✓ (packages + apps).
- `pnpm --filter rebook-ai test:integration` ✓ **22/22**, re-runnable (repeated 4× green).
- E2E ✓ (journey passed; gate test skipped by design once the journey offer is
  confirmed — on a fresh stack both execute, as in CI).
- Fresh-boot smoke: 120 flights / 41 PNRs / 4 users seeded; single inject →
  exactly 14 offers, 14 vouchers, 14 notifications, 43 events processed.

## Document sections relied on (AGENTS.md §3)

- **data-model.md** §1–§2 (schema slice, poison columns, idempotency store),
  §3 (Redis projections + rebuild-by-replay), §4/§6 (fixtures, single drizzle
  project, E2E fixtures from seed files).
- **api-contracts.md** §1 (all REST surfaces incl. confirm), §2 (event
  vocabulary — unchanged, additive-only), §3 (live frames), §5 (confirm
  behavioral contracts).
- **architecture.md** §2 (web/orchestrator split, browser never talks to the
  orchestrator), §3.1 (event-driven pipeline), §4 (control/result pattern,
  SSE bridge), §6 (poison surfacing).
- **PRD.md** F-1..F-4, F-7 (proactive notification, ranked offers with
  reasons, auto voucher, live queue + containment, RBAC ladder + audit).
- **milestones.md** F2 scope + DoD + Handoff Protocol; **demo-script.md** cast
  (Nadia/Amir/Grace, NX 288); **data-ethics.md** §2/§4 (fictional carriers,
  simulated-data labeling); **tech-stack.md** §2 (SNS mapping row);
  **engineering-standards.md** §4 (event log + idempotency), §6 (poison),
  §8 (migrations, re-runnable seed).

## Additions & deviations (Handoff Protocol §2 — docs updated to match)

All additive; no spec behavior was reinterpreted.

1. **`GET /api/v1/live` + `GET /api/v1/admin/events` documented** in
   api-contracts.md §1 (additive F2 rows): architecture §4 mandates the SSE
   bridge and §6 mandates poison surfacing, but no REST path was specified.
2. **`pnr.user_id` column** (data-model.md §2 note added): auth linkage for
   ownership scoping (D-09); nullable, background PNRs unaffected.
3. **Second passenger login** (`sofia.rossi@pax-sim.example`) + PNR linkage:
   E2E isolation from the demo-cast state; same pattern as F1's seeded users.
4. **Orchestrator reads the app's schema/seed modules** via new package
   subpath exports (`rebook-ai/db/schema`, `rebook-ai/seed-fixtures`): the one
   drizzle project stays in the app (data-model §6); no domain logic moved to
   shared packages (D-08 respected).
5. **Compose fix (F1 gap):** `rebook-web` had no `REDIS_URL` (the queue/live
   routes hung); both rebook services now set `REDIS_URL` and
   `REBOOK_SEED_DIR` explicitly.
6. **Tail poll default 150 ms** (was 300 ms in code): required to meet the
   < 1 s queue-live gate with margin (bench evidence above).

## Known limits / F3 handoff notes

- Saga steps are stubs (`pending`) by design; the executor (advance,
  compensation, crash-safe step tests) is F3.
- The expiry sweep runs every 20 s; expiry is also enforced at confirm time.
- Ranking operates on the committed inventory file (no DB seat decrement —
  seats-left accounting arrives with the F3 saga's seat_reserve step).
- `pnpm test:e2e:rebook` expects a fresh stack for the full click-through
  (`docker compose --profile rebook down -v` first); re-runs verify the
  completed state instead (documented in the spec header).
