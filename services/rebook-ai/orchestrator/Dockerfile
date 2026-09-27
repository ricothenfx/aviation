# Rebook orchestrator production image (ADR-0006 topology mirror, F5):
# tsx worker over the pnpm workspace. Build from the repo root:
#   docker build -f services/rebook-ai/orchestrator/Dockerfile -t rebook-orchestrator .
FROM node:22-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/rebook-ai ./apps/rebook-ai
COPY packages ./packages
COPY services ./services
RUN pnpm install --frozen-lockfile

FROM deps AS runner
WORKDIR /repo
ENV NODE_ENV=production
# The orchestrator reads the committed seed fixtures (ranking + policy).
COPY --from=deps /repo /repo
EXPOSE 4104
CMD ["pnpm", "--filter", "@aviation/rb-orchestrator", "start"]
