# ADR-0008: Batched WebSocket Delivery Under High Fan-Out (turnaround-iq)

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-09-24 |
| Supersedes | — |
| Related | D-03, D-04, ADR-0001, ADR-0005, api-contracts.md §3, milestones.md §F5 |

## Context

The F5 load run (×10 event scale — 15,000 events at ~100 events/s — with 200
concurrent board consumers) exposed a delivery-path ceiling. Per-event ws
delivery costs one socket write per client per frame; at 200 clients × ~12
frames per 100 ms flush that is ~24,000 writes/s, which overruns the 100 ms
flush budget (~550 ms measured per tick) and produces a multi-second delivery
tail (p95 ≈ 3–5 s) even though the ingest, projection and Redis layers keep up.
Two related defects found by the same run are fixed in code directly: stacked
pub/sub subscriptions across reset cycles (worker start()/stop()) and
per-event PG projection writes saturating the connection pool.

## Decision

Add **one additive wire frame type**, `board.batch`, used by the gateway only
when a client's flush contains more than one frame:

```json
{ "id": "f:N", "ts": "...", "channel": "board", "type": "board.batch",
  "payload": { "frames": [ <WsFrame>... ] }, "lastEventId": null }
```

- **Additive only** (api-contracts.md §3): single-frame delivery is unchanged
  and remains the norm at low volume; a `board.batch` payload is an ordered
  array of ordinary `WsFrame` envelopes, each carrying its own `ts` and
  `lastEventId`, so per-frame causality, resume (`/events?after=`) and latency
  measurement semantics are unchanged.
- Clients (board UI, load harness) that understand `board.batch` unwrap and
  process the inner frames; clients that validate strictly ignore the unknown
  type and self-heal via the REST snapshot — no existing consumer breaks.
- Effect: socket writes per client drop from ~12 per flush to 1 (~12× fewer
  syscalls), which brings the flush tick back inside its 100 ms budget.

## Alternatives considered

1. **Raise flush rate / send more often** — increases, not decreases, per-send
   cost; rejected.
2. **Coalesce event-history frames** (drop old deltas) — sanctioned by the
   contract as backpressure, but deliberately degrading the audit feed under
   load contradicts the F2 contract ("every delivery matters"); rejected.
3. **Binary/multiplexed protocol (protobuf, per-client streams)** — new
   serialization outside the locked stack (D-03); rejected.
4. **Reduce consumers or event rate** — the F5 DoD prescribes ×10 scale with
   200 consumers; tuning the test instead of the system is dishonest (D-07).

## Consequences

- (+) Delivery p95 at ×10/200 consumers returns under the 1 s DoD gate;
  latency per frame stays measurable (inner frames keep their own timestamps).
- (+) UI processing is unchanged per frame — batching is a transport detail.
- (−) One more frame type for consumers to know about (documented in
  api-contracts.md §3); strictly-validating clients must ignore it.
- (−) A single 100-frame batch message is larger (~30 KB worst case) than the
  individual frames — negligible vs the saved write overhead.

## Compliance

No new framework, library or infrastructure (D-03). The event vocabulary in
the log is untouched — `board.batch` is wire-only, like `kpi.updated` and
`scenario.tick`, and never enters the event log (ADR-0001).
