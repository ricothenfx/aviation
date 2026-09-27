# ADR-0016: rebook-ai Queue Projection — Batched Read + Coalesced Rebuild in the Orchestrator

| Field | Value |
|---|---|
| Status | Accepted (2026-09-27, rebook-ai F5 load-hardening; evidence in `docs/04-projects/rebook-ai/load-report-f5.md`) |
| Date | 2026-09-27 |
| Supersedes | — (amends ADR-0014 §4's "rebuild on every mutation" projection note additively; the rebuild-from-PG guarantee is unchanged) |
| Related | D-07, D-11, D-14, D-20, ADR-0014, ADR-0015, milestones.md §F5, api-contracts.md §3, data-model.md §3 |

## Context

The F5 load gate (milestones.md §F5 DoD) requires the **offer pipeline to surface ranked
offers p95 < 10 s at ×10 disruption scale** — defined operationally as 10 deterministic
replica banks of the reference day's rebookable slice (50 flights / 250 PNRs disrupted
in one wave; the load report records the construction). The measured behavior on the
committed F4 code:

- all 50 `flight.disrupted` events landed within 0.6 s, but offers appeared over
  **~32 s** — pipeline p95 ≈ 30 s, **3× over the gate**;
- two structural terms dominate, both in the queue projection:
  1. `loadDisruptedPnrs` issued **one latest-offer query per disrupted PNR** — at ×10
     scale every rebuild and every queue-snapshot poll executed ~250 sequential
     round-trips (and handlers rebuild after every event);
  2. **every event rebuilt the whole projection** (`rebuild()` per handler) —
     O(events × PNRs) work: 50 rebuilds × ~250 rows while the wave is still writing.
- (tiq precedent, D-14: identical class — per-event PG projection writes stretched
  rebuilds to minutes; fixed by coalescing + one bulk write.)

## Decision

1. **Batched read**: `loadDisruptedPnrs` replaces the per-PNR latest-offer query with
   **one `SELECT DISTINCT ON (pnr_id)` query** over all disrupted PNRs. The rebuild and
   the snapshot read path drop from ~2N+1 round-trips to a fixed handful, regardless of
   N. SQL semantics (latest offer per PNR by creation) are unchanged.
2. **Coalesced rebuild**: a module-level **coalescer** in the orchestrator process.
   Handlers and the saga compensation path call `scheduleQueueDelta(reason)` instead of
   `rebuild()` + `publishFrame(queueDeltaFrame(...))`:
   - the first schedule in a window starts a **250 ms flush timer** (fixed-interval
     throttle, not trailing debounce — a continuous event stream still flushes every
     window);
   - the flush performs **one rebuild** and publishes **one `queue.delta` frame**;
   - a failed flush is **retried on the next window** (bounded, with backoff) so a
     transient rebuild failure self-heals without re-running the domain event;
   - a caller that must observe projected state may still `await` the covering flush —
     the coalescer exposes both fire-and-forget scheduling (event handlers, ADR-0016
     amendment below) and await semantics (tests).
3. **Frame contract is unchanged** (api-contracts.md §3): still `queue.delta` on
   `chan:rb:live`; only the refresh *timing* moves by ≤ one window. The F2 live-update
   gate (append → `queue.delta` p95 < 1 s) keeps ~630 ms of headroom under the 250 ms
   window; the F2 benchmark (`bench:rebook-queue`) re-run must still pass.
4. **No new infra, no new package** — D-11/D-20 topology (PostgreSQL queue of record,
   Redis projection) is unchanged; the change is confined to
   `services/rebook-ai/orchestrator/src/domain/queue.ts` (+ handler call sites).

## Amendment (2026-09-27, after the first re-measurement — before the code landed)

The first post-ADR measurement run showed the gate still missed: the tail handled the
50-event wave at a median **0.82 s/event (55 s total)**. Two terms dominate, both now
in scope of this ADR (the "deferred" Alternative 4 was measured to be load-bearing,
not optional):

5. **Batched domain writes** (was Alternative 4, now included): `handleFlightDisrupted`
   collects the per-PNR effects of ONE event — vouchers, offers, offer_options,
   `offer.created`/`voucher.issued` events, notifications — and writes them in **one
   multi-row INSERT per table** instead of ~8 round-trips per PNR (40+ queries per
   5-PNR event measured). Ranking, voucher evaluation and payload schemas are
   unchanged and still per-PNR deterministic (F2 determinism gate untouched).
6. **Decoupled flush** (refines Decision 2): event handlers schedule the refresh
   **without awaiting the covering flush**. Awaiting it had serialized one coalesced
   rebuild into every sequential event (~+0.25–0.4 s/event at ×10). Eventual
   consistency is preserved by the coalescer's retry-on-failure plus the fact that any
   new event re-marks the projection dirty; live clients resync via the REST snapshot
   (api-contracts.md §3). Handlers that need projected state synchronously await
   explicitly.

## Alternatives considered

1. **Report the ×10 gate as failed, ship the F4 code** — rejected when the fix is
   small, local, and precedent-backed (D-14); reporting a fixable structural defect as
   a final result would be dishonest (D-07).
2. **Incremental ZSET updates** (`zAdd` only the affected PNRs per event) — rejected
   for this milestone: the rebuild-from-PG path is the correctness anchor (flush ⇒
   identical snapshot, F2 DoD) and the audit trail for "who is in the queue and why";
   incremental updates would fork that truth. Revisit only with a documented scale need.
3. **Larger window (1 s+)** — rejected: eats the F2 queue-latency gate headroom for no
   additional batching benefit at demo scale (the whole ×10 wave coalesces within 250 ms).
4. **Batch the per-PNR offer/voucher writes in `handleFlightDisrupted`** — initially
   deferred, **included by amendment** after the first re-measurement showed the gate
   still missed without it (0.82 s/event, 55 s wave): the query-count term, not only
   the projection refresh, was load-bearing.

## Consequences

- ×10 offer-pipeline p95 drops from ~30–55 s into the sub-10 s gate (re-measured in
  `load-report-f5.md` with committed before/after evidence, both k6 offers committed);
  the F2 single-flight gates re-run green.
- Queue snapshots at ×10 scale (~250 items) serve in tens of milliseconds instead of
  ~1 s — the load harness's 150 ms polling cadence becomes meaningful again.
- `queue.delta` fan-out is burst-shaped (≤ 4 frames/s under load instead of one per
  event); browsers resync via the REST snapshot (api-contracts.md §3), so no client
  change is needed.
- Event handlers no longer block on the projection refresh; the coalescer's bounded
  retry keeps a failed rebuild from being lost, and any subsequent event re-marks the
  projection dirty.
- New unit tests pin the coalescer semantics (many schedules ⇒ one rebuild; retry
  after failure; callers may await the covering flush); the batched read is pinned by
  the existing rebuildable-projection tests (F2) plus a multi-PNR latest-offer test;
  the batched write path keeps the per-PNR determinism gates green unchanged.
