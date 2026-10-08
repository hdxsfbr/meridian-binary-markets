# Production image for the Next.js web app (Railway: RAILWAY_DOCKERFILE_PATH=deploy/web.Dockerfile).
# Build context is the repo root so the pnpm workspace (packages/sdk) is available.
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json packages/sdk/
COPY web/package.json web/
COPY services/automation/package.json services/automation/
COPY scripts/package.json scripts/
COPY tests/package.json tests/
RUN pnpm install --frozen-lockfile
COPY packages/sdk packages/sdk
COPY web web
# Next.js inlines NEXT_PUBLIC_* at build time; Railway passes service variables as build args
# when they are declared here.
ARG NEXT_PUBLIC_CLUSTER
ARG NEXT_PUBLIC_RPC_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_PROGRAM_ID
ARG NEXT_PUBLIC_USDC_MINT
ARG NEXT_PUBLIC_AUTOMATION_STATUS_URL
ARG NEXT_PUBLIC_RPC_TX_FETCH_SPACING_MS
ENV NEXT_PUBLIC_CLUSTER=$NEXT_PUBLIC_CLUSTER \
    NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL \
    NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    NEXT_PUBLIC_PROGRAM_ID=$NEXT_PUBLIC_PROGRAM_ID \
    NEXT_PUBLIC_USDC_MINT=$NEXT_PUBLIC_USDC_MINT \
    NEXT_PUBLIC_AUTOMATION_STATUS_URL=$NEXT_PUBLIC_AUTOMATION_STATUS_URL \
    NEXT_PUBLIC_RPC_TX_FETCH_SPACING_MS=$NEXT_PUBLIC_RPC_TX_FETCH_SPACING_MS \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter web build

FROM node:22-bookworm-slim
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app /app
EXPOSE 3000
CMD ["pnpm", "--filter", "web", "start"]
