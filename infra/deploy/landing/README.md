# Landing Page Deployment — `aviation.ricothen.com` (ADR-0019)

Status: **artifacts committed; deploy awaits the host steps below** (same
pattern as the mro/rebook runbooks — human steps flagged, not faked).

The landing page is a **static export** (`apps/portfolio-landing`, `next build`
→ `out/`). It is served by the **existing `turnaround-prod` Caddy** as a
`file_server` site block — no new runtime container, no new port, no second TLS
front. Caddy obtains the certificate for `aviation.ricothen.com` automatically
(the A record has existed since the 2026-09-24 deploy; infra/deploy/README.md).

## Layout

| File | Role |
|---|---|
| `../Caddyfile` | Gained the `{$LANDING_DOMAIN:aviation.ricothen.com}` site block: `root /srv/landing`, `try_files {path} /index.html`, HSTS + nosniff headers. |
| `../compose.prod.yml` | The `caddy` service mounts `./landing:/srv/landing:ro` and passes `LANDING_DOMAIN`. |
| `landing/` (on the host, gitignored content) | The built site: `apps/portfolio-landing/out/*` copied from a CI or dev machine. |

## Deploy / update (on the host)

```bash
# 1. Build the static export (dev machine or CI):
pnpm install
pnpm build:landing                      # → apps/portfolio-landing/out/

# 2. Copy out/ to the host's landing dir (example: rsync over ssh):
rsync -av --delete apps/portfolio-landing/out/ \
  user@vps:/path/to/aviation/infra/deploy/landing/

# 3. On the host: pick up the compose env/volume changes and reload Caddy
cd /path/to/aviation/infra/deploy
docker compose -f compose.prod.yml up -d caddy
docker compose -f compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile

# 4. Verify:
curl -sf https://aviation.ricothen.com/ | grep -o "Mission control[^<]*"
curl -s -o /dev/null -w "%{http_code}\n" https://aviation.ricothen.com/icon.svg
```

## Checklist when a project goes live (D-07 honesty)

The landing page states deployment status per project from one tested config.
When executing the mro/rebook runbooks' live-deploy steps, flip the status in
the same change:

1. Edit `apps/portfolio-landing/src/lib/projects.ts`: set `status: "live"`,
   `demoUrl: "https://<project>.aviation.ricothen.com"`, `liveSince: "<date>"`.
2. `pnpm --filter portfolio-landing test` (honesty invariants must pass).
3. Rebuild + redeploy the landing (steps 1–4 above).

## Manual steps (human — flagged, not faked)

1. First deploy: run steps 1–4 above; record Caddy's
   `certificate obtained successfully` log line for `aviation.ricothen.com`
   here (mirrors the ADR-0006 TLS evidence).
2. Gitignore note: `landing/` content is host-only (build output), keep it out
   of the repository.

## Status record

- DNS `aviation` A record: existed since 2026-09-24 (reserved by ADR-0006);
  user confirmed ready 2026-09-27.
- TLS: pending first deploy (step 1 above).
