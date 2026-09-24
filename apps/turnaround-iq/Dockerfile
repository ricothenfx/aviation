# Production web image (ADR-0006): multi-stage, workspace-aware.
# Build from the repo root so the pnpm workspace context is available:
#   docker build -f apps/turnaround-iq/Dockerfile -t tiq-web .
FROM node:22-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/turnaround-iq/package.json apps/turnaround-iq/package.json
COPY packages ./packages
COPY services ./services
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG NEXT_PUBLIC_WS_URL=ws://localhost:4001/api/ws
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm --filter turnaround-iq build

FROM base AS runner
WORKDIR /repo
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=build /repo /repo
EXPOSE 3000
CMD ["pnpm", "--filter", "turnaround-iq", "start"]
