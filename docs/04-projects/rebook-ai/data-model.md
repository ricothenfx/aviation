# Rebook.ai — Data Model

| Field | Value |
|---|---|
| Status | Approved 2026-09-26 |
| Store | PostgreSQL 16, database `rebook_ai` in the shared cluster (ADR-0015; ADR-0002 precedent) |
| Migrations | drizzle-kit, forward-only, additive per milestone (engineering-standards.md §8) |

## 1. ERD (core)

```
users ──┐
        │ (actor ids)
        ▼
pnr 1──n passengers(pnr)            flights 1──n pnr_segments
 │                                       │
 │ 1──n offers ──n offer_options         │
 │          │ (ranked itineraries)       │
 │ 1──n confirmations ──1 sagas 1──n saga_steps
 │                                       │
 ├──n notifications (inbox, SNS-shaped)  │
 ├──n vouchers                           │
 └──n audit_events (append-only) ◀───────┘

event_log (append-only envelope: id, type, occurred_at, aggregate_type, aggregate_id, sequence, payload)
```

## 2. Table Notes

| Table | Purpose / binding notes |
|---|---|
| `users` | Seeded demo users (D-09): `passenger < agent < supervisor` (PRD F-7). argon2id hashes. |
| `flights` | Reference-day schedule for fictional NX/SV/BH (data-ethics.md §2): flight no (fictional blocks), origin/dest (OurAirports-style codes), sched dep/arr, aircraft, status (`scheduled | delayed | cancelled`), delay minutes. |
| `pnr` | PNR-*like* booking (synthetic): record locator (6-char fictional), passenger display name, tier (`standard | silver | gold`), fare class, contact handle (fictional), `document` JSONB — the deliberately document-shaped payload (ADR-0015): fare rules, SSR flags, loyalty balances. F2 adds `user_id` (nullable, D-09 auth linkage): seeded demo-cast bookings point at their login users so ownership scoping is a UUID comparison; background PNRs carry `null`. |
| `pnr_segments` | Booked itinerary rows per PNR (airline code, flight no, date, origin/dest, cabin, status). |
| `offers` | One offer set per (pnr, disruption): `state (proposed | confirmed | expired | superseded)`, `context` JSONB (disruption snapshot + ranking inputs for explainability), expires_at. |
| `offer_options` | Ranked options: `rank`, `kind (fast | cheap | flexible)`, `reason` (human-readable), priced itinerary JSONB (segments incl. partner codes), fare delta, `interline` bool (supervisor approval gate, architecture §3.3). |
| `confirmations` | Passenger/agent choice: offer_option_id + `Idempotency-Key` unique; opens the saga. |
| `sagas` | Fulfillment saga (ADR-0014): `state (running | completed | failed | compensated)`, pnr, offer ref, `current_step`. |
| `saga_steps` | One row per step (`seat_reserve | payment | ticket_issue`): `state (pending | running | done | failed | compensated)`, idempotency key unique, request/response JSONB stubs (simulated PSP/inventory). |
| `vouchers` | Auto meal voucher (PRD F-3): criteria JSONB (rule inputs + evaluated values — explainable), amount, `state (issued | used)`. |
| `notifications` | In-app inbox (SNS-shaped publisher, simulated delivery): `channel (inbox)`, `state (queued | delivered | failed)`, payload JSONB. |
| `proposals` | Agent-loop output (PRD F-5): recommended option, `source (llm | rules)`, `provider`, tool-call trace JSONB, token usage, `state (proposed | approved | rejected)`, approver, note. |
| `event_log` | Append-only envelope (engineering-standards.md §4); unique (aggregate_id, sequence); `processed` flag for poison-event surfacing (architecture §6). |
| `audit_events` | Append-only decision trail (who offered/confirmed/approved what, when) — INSERT only; UPDATE/DELETE blocked by trigger (mro-copilot precedent). |
| `idempotency_keys` | Replay store for mutating REST (engineering-standards.md §4): key, method, path, status, response body. |

## 3. Redis Key Design

| Key | Type | Purpose |
|---|---|---|
| `rb:queue:agent` | ZSET (score = priority) | Live agent queue; score from tier + disruption age + SLA. Rebuildable from PG. |
| `rb:pnr:{pnrId}:offers` | String (JSON snapshot) | Latest offer-set snapshot for the passenger page. |
| `chan:rb:live` | Pub/sub | Fan-out for queue + passenger updates (envelopes from packages/contracts; additive frame types, D-14 precedent). |
| `chan:rb:control` | Pub/sub | Web → orchestrator commands (inject, request-proposal), result keys `rb:result:{requestId}` (D-11 pattern). |

Redis is a disposable projection layer: every key is rebuildable by replaying `event_log`
+ state tables (architecture §4).

## 4. Seed Data (synthetic only)

- `seed/reference-day.json` — one synthetic departure bank at a fictional SIN-like hub
  (invented flight-number blocks: NX 200–899 long-haul, SV 1000–1499, BH 2000–2399).
- `seed/pnrs.json` — ~40 PNR-like records across tiers incl. the demo cast
  (families, a gold-tier frequent flyer, an interline-eligible booking).
- `seed/inventory.json` — rebookable candidate segments (seats left, fare deltas,
  cutoff times) incl. two fictional interline-style partners: SV Sentosa Air,
  BH Blue Harbor Air (data-ethics.md §2 — invented brands, never real carriers).
- `seed/policy.json` — voucher criteria, fee-waiver and cap rules (policy-check tool reads this).
- All fictional from birth; every screen labels "Simulated data for portfolio purposes".

## 5. Volumes & Scale

Reference day ≈ 120 flights, ≈ 40 seeded PNRs (×10 in F5 load runs), ≤ 10 offers per
disruption, saga steps ≤ 3 per fulfillment — sub-million-row scale by design; indexes on
(event_log.aggregate_id, sequence), (offers.pnr_id, state), (saga_steps.saga_id, state),
audit (created_at). JSONB columns carry GIN indexes where queried (offer context, document payloads).

## 6. Migrations & Seed Discipline

- One drizzle-kit project in `apps/rebook-ai` (db `rebook_ai`); migrations forward-only,
  additive per milestone; no manual DDL.
- `pnpm seed:rebook` = ensure DB → migrate → upsert users (F1) → load reference day +
  PNRs + inventory + policy (F2). Re-runnable (upserts/conflict-safe).
- Test fixtures derive from seed files — never hand-typed divergent copies.
