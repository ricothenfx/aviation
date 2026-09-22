# Tech Stack (Locked)

| Field | Value |
|---|---|
| Status | **Locked** by D-03 — changes require an approved ADR |
| Locked at | 2026-09-22 |

## 1. Core Versions

| Layer | Choice | Version | Notes |
|---|---|---|---|
| Runtime | Node.js | 22 LTS | all TS services |
| Language | TypeScript | 5.6+ (`strict`) | shared config in `packages/config` |
| Frontend | Next.js (App Router) + React | 15.x | server components where sensible |
| Styling | Tailwind CSS | v4 | tokens exported from `packages/ui` |
| Component base | shadcn/ui patterns, Radix primitives | latest | **must be themed per ui-design-system.md** |
| Charts | vis-timeline (Gantt) + Recharts or ECharts (KPIs) | latest | decision at F2 |
| API | Next.js API routes (REST) + zod validation | — | contract-first via `packages/contracts` |
| Realtime | ws (Node) + Redis pub/sub | — | envelopes from `packages/contracts` |
| Database | PostgreSQL | 16 | one cluster, per-project DBs |
| Time-series | TimescaleDB | 2.x | task telemetry, retention policy in data-model.md |
| Cache/state | Redis | 7.x | live projections + pub/sub |
| Migrations | drizzle-kit | latest | locked at F1, one tool per project |
| Auth | Custom JWT/session module, Cognito-shaped interface (D-09) | — | swap target documented |
| AI serving (Python only) | FastAPI + pydantic | 3.12 | mro-copilot model serving; turnaround-iq copilot stays TS via llm-gateway |
| LLM access | `packages/llm-gateway` (ADR-0003) | — | mock provider mandatory; no direct vendor SDKs in feature code |
| Tests | Vitest, Playwright, k6 | latest | engineering-standards.md §3 |
| Containers | Docker Compose v2 | — | profiles per project |
| CI | GitHub Actions | — | path-filtered |
| Package manager | pnpm | 9+ | workspaces |

## 2. AWS-Native Mapping (deploy-shape, per CAG JD 7133)

Every local component must be describable by its AWS production analog. This table is the
interview narrative; F5 validates the structure, not a live AWS deployment.

| Local component | AWS analog | JD keyword covered |
|---|---|---|
| Next.js web + API routes | Vercel or ECS Fargate behind ALB / Amplify Hosting | Next.js, AWS |
| realtime-gateway | API Gateway WebSocket API + Lambda (or ECS long-lived ws) | API Gateway, Lambda |
| simulator / replan-engine | ECS Fargate services (long-running) or Lambda + EventBridge Scheduler | Docker, orchestration |
| event_log writes | API GW → Lambda → SQS → consumer | SQS, SNS |
| PostgreSQL + TimescaleDB | RDS PostgreSQL | RDS |
| Redis | ElastiCache | — |
| file/doc storage (mro-copilot) | S3 | S3 |
| auth module | Amazon Cognito (interface-compatible) | Cognito, AuthN/AuthZ |
| llm-gateway Bedrock provider | Bedrock (Converse API) + AgentCore-shaped tool loop | Bedrock, AgentCore |
| notifications (rebook-ai) | SNS push/email | SNS |
| IaC | AWS CDK (structure Terraform-compatible) | CDK, Terraform, IaC |
| CI/CD | GitHub Actions → AWS deploy pipeline | CI/CD, GitHub Actions |

## 3. Prohibited Without ADR

- New databases, ORMs, CSS frameworks, state managers, cloud SDKs in feature code,
  queue systems, workflow engines, UI kit libraries beyond Radix base.
- Vendor SDK calls outside `packages/llm-gateway` and the auth module.

## 4. Upgrade Policy

Versions are pinned in root `package.json` at F1. Mid-build upgrades require: (1) an ADR,
(2) a green full CI run, (3) user approval. Security patches are exempt from the ADR
requirement but still need a green CI run.
