# Production web image for rebook-ai (ADR-0006 topology mirror, F5):
# multi-stage, workspace-aware. Build from the repo root so the pnpm
# workspace context is available:
#   docker build -f apps/rebook-ai/Dockerfile -t rebook-web .
FROM node:22-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/rebook-ai/package.json apps/rebook-ai/package.json
COPY packages ./packages
COPY services ./services
RUN pnpm install --frozen-lockfile

FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
# The web build imports the committed seed fixtures for policy lookups
# (REBOOK_SEED_DIR), so they are baked into the image.
COPY apps/rebook-ai ./apps/rebook-ai
COPY packages ./packages
COPY services ./services
RUN pnpm --filter rebook-ai build

FROM base AS runner
WORKDIR /repo
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3004
COPY --from=build /repo /repo
EXPOSE 3004
CMD ["pnpm", "--filter", "rebook-ai", "start"]
