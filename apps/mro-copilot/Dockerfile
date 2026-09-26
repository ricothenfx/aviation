# Production web image for mro-copilot (ADR-0006 topology mirror, F5):
# multi-stage, workspace-aware. Build from the repo root so the pnpm
# workspace context is available:
#   docker build -f apps/mro-copilot/Dockerfile -t mro-web .
FROM node:22-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/mro-copilot/package.json apps/mro-copilot/package.json
COPY packages ./packages
COPY services ./services
RUN pnpm install --frozen-lockfile

FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
# The build imports the shared UI/contracts workspace packages only;
# turnaround-iq sources are copied for the workspace lockfile but not built.
RUN pnpm --filter mro-copilot build

FROM base AS runner
WORKDIR /repo
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=build /repo /repo
EXPOSE 3000
CMD ["pnpm", "--filter", "mro-copilot", "start"]
