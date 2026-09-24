# Realtime-gateway / simulator / replan-engine production image (ADR-0006).
# One parameterised build for the three tsx services:
#   docker build -f services/turnaround-iq/Dockerfile \
#     --build-arg SERVICE=realtime-gateway -t tiq-realtime-gateway .
FROM node:22-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services
RUN pnpm install --frozen-lockfile

FROM deps AS runner
WORKDIR /repo
ENV NODE_ENV=production
ARG SERVICE=realtime-gateway
ENV SERVICE_PACKAGE=@aviation/tiq-$SERVICE
COPY --from=deps /repo /repo
CMD ["sh", "-c", "pnpm --filter \"$SERVICE_PACKAGE\" start"]
