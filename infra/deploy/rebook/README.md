# Demo Deployment — rebook-ai Runbook (F5, mirroring ADR-0006/D-12)

Status: **prepared; prod topology locally validated; live deploy awaits the human
steps below** (flagged, not faked). Per tech-stack.md §2 (locked), this validates the
deployment *structure*, not a live AWS deployment; the AWS mapping table below is the
interview narrative (traceability-matrix row).

URL scheme per ADR-0006 §Execution record: `rebook-ai.aviation.ricothen.com` on the
same VPS as the live turnaround-iq demo, one hostname per project, Caddy terminating
TLS for each (the mro-copilot record in `../mro/README.md` describes the shared-front
options; the same choice applies here).

## Layout

| File | Role |
|---|---|
| `compose.prod.yml` | Production topology: the CI-validated `--profile rebook` services (postgres, redis, rebook-web, rebook-orchestrator) + Caddy auto-TLS. Postgres/redis/orchestrator are network-internal; Caddy 80/443 is the only public surface (ADR-0014: the browser reaches the worker through the web app's REST/SSE bridge). |
| `Caddyfile` | TLS + routing: everything → rebook-web:3004 (single upstream; SSE passes through). |
| `env.example` | The only secrets the deployment needs (server-side `.env`, never committed). |
| `../../apps/rebook-ai/Dockerfile` | Production web image (workspace-aware multi-stage, `next build` + `next start -p 3004`, committed seed fixtures baked in). |
| `../../services/rebook-ai/orchestrator/Dockerfile` | Production worker image (pnpm workspace + tsx, internal-only). |

Topological identity with CI-validated local runs: same base images (node:22 /
timescale-pg16 / redis:7), same service set as `docker compose --profile rebook up -d`,
same migrations + seed on boot — a fresh clone and this prod topology differ only in
secrets, replicas (1) and the Caddy front.

## Local validation (what was actually executed — 2026-09-27)

The prod images and boot chain were validated on the dev host with a throwaway
override (not committed) that publishes web/orchestrator to loopback and skips Caddy
(no DNS/ACME locally):

```bash
cat > /tmp/rebook-validate.yml <<'EOF'
services:
  caddy:
    scale: 0
  rebook-web:
    ports: !override ["127.0.0.1:3004:3004"]
  rebook-orchestrator:
    ports: !override ["127.0.0.1:4104:4104"]
EOF
cp infra/deploy/rebook/env.example infra/deploy/rebook/.env   # dev values
docker compose -f infra/deploy/rebook/compose.prod.yml \
  -f /tmp/rebook-validate.yml up -d --build --wait
curl -sf http://localhost:3004/healthz && curl -sf http://localhost:3004/readyz
curl -sf http://localhost:4104/healthz && curl -sf http://localhost:4104/readyz
# seeded logins (all three roles) + one demo beat: inject NX 288 as the
# supervisor, poll the queue as the agent — offers appear < 10 s.
```

Recorded result: all four health/ready probes green; seeded passenger/agent/supervisor
logins OK; one demo beat (inject → ranked offers visible in the agent queue) OK.
Cleanup: `docker compose -f infra/deploy/rebook/compose.prod.yml -f /tmp/rebook-validate.yml down -v`.

## Deploy (automatable — run on the VPS)

Prerequisites (host): Ubuntu 22.04/24.04, Docker + Compose v2, ports 80/443 reachable,
DNS `DOMAIN` → this host (A/AAAA), git access.

```bash
git clone <repo-url> aviation && cd aviation
cp infra/deploy/rebook/env.example infra/deploy/rebook/.env   # then fill secrets
docker compose -f infra/deploy/rebook/compose.prod.yml up -d --build --wait
# verify (all must be green):
curl -sf https://$DOMAIN/healthz
curl -sf https://$DOMAIN/readyz          # db + provider "up"
# seeded login + one demo beat per demo-script.md (supervisor inject → passenger offers)
```

Boot chain: postgres healthy → redis healthy → rebook-web (applies migrations, seeds
users, serves the production build) healthy → rebook-orchestrator (event tail +
saga executor) → caddy solves the ACME challenge and serves TLS.

## Manual steps (human — flagged, not faked)

1. **Host share / front choice**: the live turnaround-iq demo already occupies the
   VPS's ports 80/443; a second Caddy cannot bind them. Either extend the existing
   tiq Caddy with a site block for `rebook-ai.aviation.ricothen.com` pointing at this
   project's rebook-web over a shared docker network, or migrate all fronts into one
   compose. Decide per ADR-0006 §Execution record (same decision the mro deploy
   records in `../mro/README.md` §Manual steps).
2. **DNS**: add `rebook-ai.aviation` A/AAAA → the VPS (zone `ricothen.com`).
   DNS: done 2026-09-27 (`rebook-ai.aviation.ricothen.com`; also set in
   `env.example` as `DOMAIN`). Live deploy itself remains open — see step 1/4.
3. **Secrets**: generate `AUTH_SECRET` + `POSTGRES_PASSWORD` (`openssl rand -hex 32`
   / `-hex 16`), set `ACME_EMAIL`.
4. **TLS evidence**: after first boot, record Caddy's
   `certificate obtained successfully` log line + expiry in this file.
5. **Demo capture**: the 90 s walkthrough video is recorded by a human
   (demo-script.md provides the exact beat sheet, including the 80–90 s audit-trail
   beat); hosting is human-chosen (unlisted video or on-request). Do not fabricate
   a link.

## IaC-ready mapping (traceability-matrix row)

| compose.prod.yml unit | AWS construct (tech-stack.md §2) |
|---|---|
| `rebook-web` | ECS Fargate service (+ ALB target group) |
| `rebook-orchestrator` | ECS Fargate service, internal load balancer / service connect |
| `postgres` | RDS PostgreSQL 16 (Multi-AZ) |
| `redis` | ElastiCache Redis |
| `caddy` | ALB (TLS termination) + Route 53 |
| `.env` | AWS Secrets Manager + SSM Parameter Store |

## Verification checklist (post-deploy)

- [ ] `GET /healthz` → `{"status":"ok"}` over HTTPS
- [ ] `GET /readyz` → db + provider `"up"` (both services)
- [ ] Seeded logins work for all three roles; RBAC ladder blocks passenger on agent routes
- [ ] One demo beat: supervisor inject → ranked offers visible; passenger confirm → saga → boarding pass (labeled simulated)
- [ ] Simulated-data footer visible on every surface
- [ ] Caddy log: ACME challenge solved, certificate obtained (record date + expiry)

## Ops notes

- Health: `GET /healthz` + `/readyz` on web and orchestrator; wire an uptime checker
  against `https://$DOMAIN/healthz`.
- Logs: `docker compose -f compose.prod.yml logs -f` (structured JSON, D-08).
- Secrets: server-side `.env` only. Nothing secret is committed.
- Sizing: 1× demo traffic is ~10× smaller than the ×10 load evidence; the F5 paced
  gate passed on a 4-core host shared with everything else, so a 2 vCPU VPS shared
  with the tiq demo is comfortable (load-report-f5.md).
