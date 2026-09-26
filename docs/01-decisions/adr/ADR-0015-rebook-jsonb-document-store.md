# ADR-0015: Rebook.ai Datastore — PostgreSQL JSONB for Document-Shaped PNR/Offer Models (No MongoDB)

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-09-26 |
| Supersedes | — |
| Related | ADR-0002 (PostgreSQL-over-MongoDB precedent), D-03 (locked stack), rebook-ai PRD §"Planned stack deltas", data-model.md |

## Context

The rebook-ai PRD skeleton mandates an honest evaluation "at spec time" of
MongoDB-shaped document modeling against PostgreSQL JSONB (ADR-0002 precedent). The
domain is PNR-like bookings with schema-flexible fare/loyalty payloads, ranked offers
with ranking-context bundles, policy-rule evaluations, and saga step stubs — genuinely
document-shaped. Airline/travel-tech employers (Amadeus, SITA, Sabre) also interview on
document stores, so the keyword temptation is real.

## Decision

Primary datastore is **PostgreSQL 16, database `rebook_ai`** (one shared cluster,
per-project DB). Document-shaped payloads (PNR `document`, offer `context`, voucher
`criteria`, saga request/response stubs, proposal tool traces) live in **JSONB columns
with GIN indexes where queried**. No MongoDB; no new infrastructure.

## Rationale

1. The core domain is transactional and relational at its edges: offers and their options
   have integrity constraints (one confirmed option per offer, saga steps unique per key),
   confirmations are idempotent by key, and fulfillment must be transactional with the
   event log. MongoDB would push exactly these invariants into application code.
2. ADR-0002 already defended this trade-off for turnaround-iq; re-using the pattern keeps
   the portfolio's datastore story coherent (one engine + JSONB where it shines) instead
   of adding a second database for keyword coverage — the complexity a portfolio cannot
   defend (ADR-0002 alternative 2).
3. The JD's underlying requirement — designing document-based models — is demonstrably
   met and will be stated explicitly in the traceability matrix with an honest note,
   exactly as turnaround-iq does.

## Alternatives considered

1. **MongoDB as the document store alongside PostgreSQL** — maximum keyword coverage;
   rejected: two engines for one small dataset, cross-store consistency in the saga path,
   contradicts ADR-0002's own rejection of this for the same reasons.
2. **MongoDB as the only store** — matches travel-tech JD letters verbatim; rejected:
   the fulfillment saga loses transactional multi-document guarantees for its hottest
   invariant (exactly-one-effect per confirm), which is the product's core honesty claim.
3. **Flat relational columns everywhere (no JSONB)** — maximum join-ability; rejected:
   fare rules/policy evaluations genuinely vary per carrier/tier; forcing them into
   columns produces sparse-table churn with no integrity gain.

## Consequences

- (+) One engine to operate; saga, idempotency and event-log invariants stay in-transaction.
- (+) The document-modeling skill is demonstrated where it fits, with GIN-indexed queries.
- (−) CV keyword mismatch with literal "MongoDB" lines — mitigated by the traceability
  note and by keeping JSONB usage genuinely document-shaped (schema-flexible, not a
  relational row smuggled into JSON).
- (−) No MongoDB operational experience shown — stated honestly rather than papered over.
