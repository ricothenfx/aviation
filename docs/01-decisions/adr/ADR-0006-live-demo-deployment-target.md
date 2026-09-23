# ADR-0006: Live Demo Deployment Target — Single VPS + Compose + Caddy (AWS Stays as Deploy-Shape Mapping)

| Field | Value |
|---|---|
| Status | Proposed — pending user approval |
| Date | 2026-09-24 |
| Supersedes | — |
| Related | D-01, D-03, D-05, tech-stack.md §2, traceability-matrix.md rows 7/9/10, milestones.md §F5 |

## Context

Milestone F5 requires a public live demo URL. The constraints in tension:

1. **The JD requires AWS** (CAG Req 7075 requirement 9 "AWS — deploy, operate,
   integrate"; Req 7133 lists Lambda/API Gateway/RDS/Cognito/Bedrock).
2. **The locked stack already answers that**: tech-stack.md §2 (locked 2026-09-22)
   defines the AWS-native mapping as the *deploy-shape narrative* and states
   explicitly: "F5 validates the structure, not a live AWS deployment."
   traceability-matrix.md row 9 makes the same choice: the F5 deliverable for AWS
   is "AWS service mapping + IaC-ready deploy config (CDK-compatible structure)".
3. **A live AWS deployment is not free**: the realtime gateway uses long-lived
   WebSockets, which do not map to Lambda — a faithful AWS deploy means API
   Gateway WebSocket API + DynamoDB connection state or ECS Fargate for 6
   long-lived tasks (≈ US$15–30+/month plus IAM/networking setup and a
   redesign that belongs to a different milestone, D-05).
4. The current compose topology (6 services, loopback-only bindings) is exactly
   what CI validates; compose comment marks "a public demo binding" as an F5
   concern, and traceability row 7 defers "production Dockerfiles" to F5.

## Decision

Deploy the live demo to a **single small Linux VPS** (Hetzner CX22-class or
DigitalOcean droplet, ≈ US$6/month; Oracle Cloud Always-Free ARM is the $0
fallback), running the **same six-service topology behind a production
override**, fronted by **Caddy** for automatic Let's Encrypt TLS on a user-owned
domain. Concretely:

- **Production images**: multi-stage Dockerfiles (web: `next build`; the three
  TS services: production deps + tsx runtime) replace the dev bind-mount
  containers in `compose.prod.yml`. Data services (postgres/redis) stay on
  official images, **bound to loopback only** on the host; the only publicly
  exposed ports are Caddy's 80/443.
- **Topological identity**: same services, same event flow, same contracts as
  CI-validated local runs — the demo shows the system that was actually tested.
- **IaC-ready structure**: `infra/deploy/` contains `compose.prod.yml`,
  `Caddyfile`, a bootstrap script, and a deploy/rollback runbook, organized so
  each unit maps to a future CDK/Terraform construct (documented in the
  README of `infra/deploy/`). This satisfies traceability rows 7/9/10 without
  pretending to be a cloud deployment.
- **Secrets stay out of the repo**: server-side `.env` only (`AUTH_SECRET`
  production value, domain name); `.env.example` documents them.
- **AWS story remains the locked mapping** (tech-stack.md §2). The ADR-0006
  trade-off ("why is the demo not live on AWS?") is interview material, not a
  hidden gap: single VPS, no auto-scaling, demo-grade sizing — stated openly.

## Alternatives considered

1. **Live AWS deployment (ECS Fargate / API GW WebSocket + Lambda)** — strongest
   JD signal, but contradicts the locked tech-stack.md §2 decision, costs
   ≈ US$15–30+/month for 6 long-lived tasks, needs the ws redesign, and adds a
   milestone-sized scope D-05 forbids. Rejected for F5; may be revisited as a
   separate decision if the user wants it.
2. **Fly.io** — built-in TLS, no domain purchase, but six always-on services
   map awkwardly (six apps or a full VM running compose) with more platform
  -specific wiring than a plain VPS; rejected.
3. **Cloudflare Tunnel from a local machine** — $0 and no port forwarding, but
   the demo dies with the dev machine and the "production ownership" narrative
   (JD: seniority signal E) is weakest; rejected.
4. **Ship no live demo** — violates F5 DoD; rejected.

## Consequences

- (+) Full live demo at ≈ US$6/month with zero architectural redesign; the
  deployment artifacts themselves become evidence for JD rows 7 (Docker) and
  10 (CI/CD + ops).
- (+) Honest, defensible AWS narrative: mapping table + IaC-ready structure
  exactly as the locked docs prescribe.
- (−) No auto-scaling/HA; a single VM is a demo, not a production SLO —
  documented as such in the README.
- (−) One-time work in F5: 4 production Dockerfiles + override + Caddyfile +
  runbook; deploy execution additionally needs user-owned secrets/host.
- (−) TLS depends on a user-supplied domain.

## Compliance

No service or library outside tech-stack.md is introduced (Caddy and the prod
Dockerfiles are deployment artifacts of the locked stack, covered by this ADR).
Loopback-only bindings for postgres/redis are preserved in all profiles. No
secret enters the repository.
