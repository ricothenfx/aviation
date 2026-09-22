# Rebook.ai — PRD (Skeleton)

| Field | Value |
|---|---|
| Status | **Spec pending** — full specification happens when its build window opens (D-02). Do not implement from this skeleton. |
| One-liner | Passenger disruption concierge: proactive rebooking offers in seconds, with an agentic workflow that optimizes cost vs. passenger experience under human agent supervision. |

## Problem (draft)
On disruption, passengers queue at counters while agents manually re-accommodate one by
one; DCS-era tooling offers no proactive options. Cost: rebooking spend, compensation,
and churned flyers (acquisition costs 5–25× retention).

## Solution (draft)
Two-sided platform:
1. **Passenger** — proactive notification within seconds of `flight.disrupted`; ranked rebooking options (fast/cheap/flexible); one-tap confirm; auto meal voucher when delay criteria met.
2. **Agent console** — queue that shrinks as passengers self-serve; agentic workflow searches alternative routings (incl. interline-style partners), applies policy/compensation rules, prepares decisions for human approval; saga pattern for seat-reserve → pay → issue; idempotent, auditable.

## Planned stack deltas (from locked platform)
Mostly TS (D-03): orchestrator service + agent loop via `packages/llm-gateway`; SNS-shaped notification abstraction; MongoDB-shaped document modeling candidates evaluated honestly against PostgreSQL JSONB (ADR-0002 precedent) at spec time.

## Primary targets
SIA/Scoot (Customer Experience, Application Developer), Amadeus, SITA, Sabre; CAG Commercial division.

## Datasets
Hand-written synthetic schedule + PNR-like records (fictional airlines per data-ethics.md); no real PNRs.

## TODO at spec time
Full PRD, architecture (saga/orchestration), data model, API/event contracts, milestones F1–F5, demo script ("SQ-style cancellation to new boarding pass in 90 s").
