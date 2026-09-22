# ADR-0002: PostgreSQL (+ TimescaleDB) Instead of MongoDB for turnaround-iq

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-09-22 |
| Supersedes | — |
| Related | D-03, traceability-matrix.md row 4 |

## Context

CAG's Senior Software Engineer JD lists **MongoDB** as a hard requirement. The portfolio
must decide its primary datastore honestly: follow the JD letter, or optimize for the domain.

## Decision

Primary datastore is **PostgreSQL 16 with TimescaleDB** for task telemetry; Redis holds
ephemeral live state. Document-shaped data (replan scenarios, task configs, AI copilot
context bundles) is stored in **JSONB columns** with GIN indexes, demonstrating deliberate
document modeling inside a relational core.

## Rationale

1. The scheduling domain is intensely relational (flights ↔ gates ↔ tasks ↔ dependencies, foreign keys, transactional replans). PostgreSQL models integrity constraints that MongoDB would leave to application code.
2. Event sourcing (ADR-0001) needs transactional append + projection reads; one engine keeps consistency trivial.
3. TimescaleDB gives honest time-series retention/compression for task telemetry — a real airport-ops pattern.
4. The JD's underlying requirement — *designing document-based data models* — is demonstrably met via the JSONB design and is called out explicitly in the traceability matrix with an honest note. Interviewers consistently value a defended trade-off over silent conformity.

## Alternatives considered

1. **MongoDB as primary** — matches JD verbatim; rejected: weaker fit for relational scheduling + event sourcing; two databases would fragment the story.
2. **Both MongoDB and PostgreSQL** — maximum keyword coverage; rejected: unjustifiable complexity in a portfolio where every component must be defensible.

## Consequences

- (+) One datastore to operate; relational integrity for replan transactions.
- (+) A senior-level talking point ("here is why I diverged from your listed stack").
- (−) CV keyword mismatch with the literal MongoDB line — mitigated by the traceability note and by keeping JSONB usage genuinely document-shaped (schema-flexible payloads).
