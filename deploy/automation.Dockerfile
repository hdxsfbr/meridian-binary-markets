# Production image for the automation worker (Railway: RAILWAY_DOCKERFILE_PATH=deploy/automation.Dockerfile).
# Runs the cron schedule (`automation start`); keypairs arrive as ADMIN_KEYPAIR_JSON /
# PUBLISHER_KEYPAIR_JSON variables (services/automation/src/keys.ts).
FROM node:22-bookworm-slim
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages/sdk/package.json packages/sdk/
COPY web/package.json web/
COPY services/automation/package.json services/automation/
COPY scripts/package.json scripts/
COPY tests/package.json tests/
RUN pnpm install --frozen-lockfile
COPY packages/sdk packages/sdk
COPY services/automation services/automation
RUN pnpm --filter automation build
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "automation", "start"]
