# Demo Deployment — Runbook (ADR-0006)

Status: **deployed and live** — `https://turnaround-iq.aviation.ricothen.com`
(since 2026-09-24). Per tech-stack.md §2 (locked): F5 validates the deployment
*structure*, not a live AWS deployment. The AWS service mapping (tech-stack.md
§2) remains the interview narrative; this directory is the IaC-ready equivalent
for a single VPS.

## Live host (as executed, 2026-09-24)

- **Host**: single VPS (`194.233.67.201`), Ubuntu, Docker + Compose v2.
- **DNS** (zone `ricothen.com`, both → `194.233.67.201`):
  - `turnaround-iq.aviation` — the live demo (this deploy).
  - `aviation` — reserved for the future portfolio landing page (not yet
    configured in the Caddyfile; dormant record).
- **URL scheme**: one hostname per project (`turnaround-iq.aviation.ricothen.com`,
  later `mro-copilot.…`, `rebook-ai.…`), landing page at
  `aviation.ricothen.com` — recorded in ADR-0006 §Execution record. `DOMAIN`
  in the server-side `.env` selects the hostname; the Caddyfile is generic.
- **Public surface**: ports 22/80/443 only. The production compose publishes
  nothing except Caddy (80/443); postgres/redis are compose-network-internal;
  the dev stack on this box binds to loopback only.
- **Firewall** (host step, run as root): `ufw` is active on this box — allow
  exactly `sudo ufw allow 22,80,443/tcp` and review with
  `sudo ufw status verbose`. Docker-published ports bypass ufw INPUT rules,
  so the compose-level guarantee (only Caddy publishes) is the real boundary.
- **TLS evidence (2026-09-24)**: Caddy solved the ACME `tls-alpn-01` challenge
  and logged `certificate obtained successfully` for
  `turnaround-iq.aviation.ricothen.com` (issuer Let's Encrypt, valid to
  2026-12-23); cert renews automatically (`caddy_data` volume persists).


## Layout

| File | Role |
|---|---|
| `compose.prod.yml` | Production topology: same six services as CI-validated local runs + Caddy (auto-TLS). Data services are network-internal; Caddy 80/443 is the only public surface. |
| `Caddyfile` | TLS + path routing: `/api/ws*` → realtime-gateway:4001, everything else → web:3000. |
| `env.example` | The only secrets the deployment needs (server-side `.env`, never committed). |
| `../apps/turnaround-iq/Dockerfile`, `../services/turnaround-iq/Dockerfile` | Multi-stage production images (web: `next build`/`next start`; services: pnpm workspace + tsx). |

## IaC-ready mapping (traceability-matrix row 9)

Each unit here maps 1:1 to a future cloud construct — the CDK/Terraform port is
mechanical, not architectural:

| compose.prod.yml unit | AWS construct (tech-stack.md §2) |
|---|---|
| `web`, `simulator`, `realtime-gateway`, `replan-engine` | ECS Fargate services (1 task definition each) |
| `postgres` | RDS PostgreSQL (Multi-AZ for prod) |
| `redis` | ElastiCache Redis |
| `caddy` | ALB (TLS termination) + Route 53 |
| `.env` | AWS Secrets Manager + SSM Parameter Store |

## Deploy (first time)

1. Provision a VPS ≥ 2 vCPU / 4 GB (load-report-f5.md §4: the ×10 harness
   saturates 4 cores; 1× demo traffic needs ~10× less). Ubuntu 24.04.
2. Install Docker: `curl -fsSL https://get.docker.com | sh`.
3. DNS: point `DOMAIN` (A/AAAA record) at the server.
4. `git clone git@github.com:ricothenfx/aviation.git && cd aviation/infra/deploy`
5. `cp env.example .env` → fill `DOMAIN`, `ACME_EMAIL`, `AUTH_SECRET`
   (`openssl rand -hex 32`), `POSTGRES_PASSWORD` (`openssl rand -hex 16`).
6. `docker compose -f compose.prod.yml up -d --build` — Caddy obtains the
   certificate automatically.
7. Seed + boot the demo: `docker compose -f compose.prod.yml exec web sh -c
   "pnpm --filter @aviation/db migrate && pnpm --filter turnaround-iq seed"`
   then start the scenario via the UI (supervisor login) so the board is live.

## Deploy (update)

```bash
git pull
docker compose -f compose.prod.yml up -d --build
docker image prune -f
```

## Rollback

```bash
git checkout <previous-tag-or-sha>
docker compose -f compose.prod.yml up -d --build
```

Data services keep their volumes; the event log and projections are untouched
by application rollbacks (ADR-0001: replay-derivable).

## Ops notes

- Health: `GET /healthz` + `/readyz` on every service (api-contracts.md §1) —
  wire an uptime checker against `https://$DOMAIN/healthz`.
- Logs: `docker compose -f compose.prod.yml logs -f` (structured JSON, D-08).
- Secrets: server-side `.env` only. Nothing secret is committed.
- Sizing honesty (load-report-f5.md §4): this topology serves 1× demo traffic
  comfortably on 2 vCPU; the ×10 load gate ran on a 4-core host with the
  harness itself consuming ~half of it.
