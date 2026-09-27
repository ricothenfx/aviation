# portfolio-landing

The portfolio landing page at `aviation.ricothen.com` (ADR-0019): one CV-safe entry point that
frames all three systems and routes reviewers to live demos, case studies, and the traceability
matrix.

- **Static export** — `next build` emits `out/`; Caddy serves it with `file_server` (no runtime
  service). The only client-side behavior is the UTC/Singapore ops clock.
- **Single source of truth** — statuses, demo URLs, and metrics render from
  `src/lib/projects.ts`; unit tests pin the honesty invariants (a `prepared` project never
  renders a demo link; every metric cites a committed report that exists in the repo).
- **Flip a status** when a deployment goes live: edit `src/lib/projects.ts` (set `status: "live"`,
  `demoUrl`, `liveSince`), run `pnpm --filter portfolio-landing test`, rebuild, redeploy.

## Commands

```bash
pnpm dev:landing                 # (root script) next dev on :3005
pnpm --filter portfolio-landing build   # static export into out/
pnpm --filter portfolio-landing test    # honesty-invariant unit tests
```

## Deploy

See `infra/deploy/landing/README.md` — copy `out/*` to the host's `infra/deploy/landing/`,
reload Caddy (the `aviation.ricothen.com` site block is part of `infra/deploy/Caddyfile`).
