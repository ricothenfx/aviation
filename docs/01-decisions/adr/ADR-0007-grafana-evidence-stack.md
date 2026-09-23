# ADR-0007: Grafana + Prometheus as an Ephemeral "Evidence" Profile for Load Tests

| Field | Value |
|---|---|
| Status | Proposed — pending user approval |
| Date | 2026-09-24 |
| Supersedes | — |
| Related | D-03, D-07, tech-stack.md §1 (k6 already approved), milestones.md §F5 |

## Context

Milestones.md §F5 prescribes "k6 load test (×10 scenario scale, 200 concurrent
consumers) + Grafana dashboard" as acceptance evidence. k6 is already part of
the locked stack (tech-stack.md §1, Tests row). **Grafana is not**: tech-stack.md
contains no observability/visualization layer at all, and D-03 forbids adding
any component outside tech-stack.md without an approved ADR. Hence this ADR
must exist — and be approved — before Grafana is pulled or run.

## Decision

Add a **dedicated, ephemeral "evidence" observability profile** to the compose
file, separate from the `turnaround` profile:

- **Components**: Prometheus + Grafana, both as pinned official Docker images,
  plus k6 (image `grafana/k6`, already approved) publishing metrics via
  Prometheus remote-write.
- **Lifecycle**: started only for load runs (`docker compose --profile evidence
  up`), torn down afterwards. It is **never** part of the demo/dev stack and
  never deployed to the public demo host.
- **Versioned evidence**: the Grafana dashboard JSON and the k6 scenario script
  live in the repo (committed), so every number in the F5 load report is
  reproducible from a committed script (data-ethics.md §4) and the dashboard is
  reviewable without running anything.
- **Honest reporting**: the load report records the full run — including
  whatever misses the < 1 s p95 target — sourced from this stack.

## Alternatives considered

1. **No Grafana; k6 text/summary output only** — cheapest, but milestones.md
   §F5 explicitly prescribes a Grafana dashboard, and the milestone scope is
   binding (D-05); silently narrowing scope is not allowed. Rejected.
2. **Permanent observability in the `turnaround` profile** — turns evidence
   tooling into always-on infrastructure, expands the locked demo stack, and
   contradicts "Grafana is for the load run" in the F5 scope. Rejected.
3. **Host-native installs (apt/brew grafana, k6 binary)** — pollutes the host,
   unreproducible by CI or reviewers; everything stays containerized instead.

## Consequences

- (+) Milestone-prescribed dashboard exists, reproducible from the repo, with
  zero footprint on the demo stack and no host installs.
- (+) Metrics honesty is structural: the dashboard + k6 script + report come
  from the same run.
- (−) Two additional images are pulled at evidence time (Prometheus, Grafana);
  acceptable one-time ~100 MB cost.
- (−) Metrics exist only during load runs (ephemeral by design); historical
  dashboards are the committed JSON + the report, not a live server.

## Compliance

This ADR is the tech-stack.md §3 exception record for Grafana/Prometheus in the
`evidence` profile only. Adding either to any other profile requires a new ADR.
