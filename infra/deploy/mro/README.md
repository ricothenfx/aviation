# Demo Deployment — mro-copilot Runbook (F5, mirroring ADR-0006)

Status: **prepared, not yet deployed** — everything automatable is committed
(topology, images, runbook, seed state); the human steps are flagged in
§Manual steps and are deliberately not faked. Per tech-stack.md §2 (locked),
this validates the deployment *structure*, not a live AWS deployment; the AWS
mapping table below is the interview narrative (traceability-matrix row 9).

URL scheme per ADR-0006 §Execution record: `mro-copilot.aviation.ricothen.com`
on the same VPS as the live turnaround-iq demo (`turnaround-iq.aviation.…`),
one hostname per project, Caddy terminates TLS for each.

## Layout

| File | Role |
|---|---|
| `compose.prod.yml` | Production topology: the CI-validated `--profile mro` services (postgres, mro-web, mro-ai-service) + Caddy auto-TLS. Data services network-internal; Caddy 80/443 the only public surface; the ai-service is never published (ADR-0012). |
| `Caddyfile` | TLS + routing: everything → mro-web:3003 (single upstream — no websocket path). |
| `env.example` | The only secrets the deployment needs (server-side `.env`, never committed). |
| `../../apps/mro-copilot/Dockerfile` | Production web image (workspace-aware multi-stage, `next build` + `next start -p 3003`). |
| `../../services/mro-copilot/ai-service/Dockerfile` | Production ai-service image: pinned ML stack, committed RUL artifact baked in (`/readyz` gates `model: up` from first boot), synthetic corpus baked in and ingested at startup (FR-5 idempotent). |

Topological identity with CI-validated local runs: same images' base (node:22 /
python:3.12 / timescale-pg16-with-pgvector), same service set as
`docker compose --profile mro up -d`, same migrations + seed on boot — a fresh
clone and this prod topology differ only in secrets, replicas (1) and the
Caddy front.

## Deploy (automatable — run on the VPS)

Prerequisites (host): Ubuntu 22.04/24.04, Docker + Compose v2, ports 80/443
reachable, DNS `DOMAIN` → this host (A/AAAA), git access.

```bash
git clone <repo-url> aviation && cd aviation
cp infra/deploy/mro/env.example infra/deploy/mro/.env   # then fill secrets
docker compose -f infra/deploy/mro/compose.prod.yml up -d --build
# verify (all three must be green):
curl -s https://$DOMAIN/healthz
curl -s https://$DOMAIN/readyz        # postgres/pvvector/model/provider all "up"
# seeded login + one grounded ask — demo-script.md §steps
```

Boot chain: postgres healthy → mro-web (applies migrations incl.
`CREATE EXTENSION vector`, Timescale hypertable, seeds users) healthy →
mro-ai-service (ingests the corpus idempotently, loads + hash-verifies the RUL
artifact) → caddy solves the ACME challenge and serves TLS.

## Manual steps (human — flagged, not faked)

1. **Provision/allocate the host share**: the live turnaround-iq demo already
   occupies the VPS; confirm capacity (mro demo needs ~1.5 GB RAM, ~1 core at
   demo traffic) and that ports 80/443 stay forwarded to Caddy (already the
   case for the tiq deploy — the same Caddy cannot serve two compose projects,
   so EITHER run this compose on the same host with its own Caddy bound to the
   same ports after stopping nothing (NOT possible — port conflict) OR extend
   the EXISTING tiq Caddy with an additional site block for
   `mro-copilot.aviation.ricothen.com` pointing at this project's mro-web.
   Recommended: extend the existing Caddyfile (one-line site block + shared
   docker network), which is why `compose.prod.yml` is kept self-contained but
   the caddy service can be dropped with `--scale caddy=0` when reusing the
   host's existing front. Decide per ADR-0006 §Execution record.
2. **DNS**: add `mro-copilot.aviation` A/AAAA → the VPS (zone `ricothen.com`).
3. **Secrets**: generate `AUTH_SECRET`, `POSTGRES_PASSWORD`, `AI_SERVICE_TOKEN`
   (`openssl rand -hex 32`), set `ACME_EMAIL`.
4. **TLS evidence**: after first boot, record Caddy's
   `certificate obtained successfully` log line + expiry in this file.
5. **Demo capture**: the 90 s walkthrough video is recorded by a human
   (demo-script.md provides the exact beat sheet); hosting is human-chosen
   (unlisted video or on-request). Do not fabricate a link.

## IaC-ready mapping (traceability-matrix row 9)

| compose.prod.yml unit | AWS construct (tech-stack.md §2) |
|---|---|
| `mro-web` | ECS Fargate service (+ ALB target group) |
| `mro-ai-service` | ECS Fargate service, internal load balancer / service connect |
| `postgres` (pgvector + Timescale) | RDS PostgreSQL 16 (Multi-AZ) with pgvector extension |
| `caddy` | ALB (TLS termination) + Route 53 |
| `.env` | AWS Secrets Manager + SSM Parameter Store |

## Verification checklist (post-deploy)

- [ ] `GET /healthz` → `{"status":"ok"}` over HTTPS
- [ ] `GET /readyz` → postgres/pgvector/model/provider all `"up"`
- [ ] Seeded reviewer login works; RBAC ladder blocks viewer on reviewer actions
- [ ] One grounded ask with citations; one explicit refusal (demo-script.md)
- [ ] Sign-off: engineer ask → reviewer approve → verified library shows it
- [ ] Fleet dashboard: model provenance strip (v1.0.0 + sha) + simulated-data footer
- [ ] Caddy log: ACME challenge solved, certificate obtained (record date + expiry)
