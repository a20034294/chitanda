# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build

ARG PNPM_VERSION=12.4.2
RUN npm install --global "pnpm@${PNPM_VERSION}"

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/analysis/package.json packages/analysis/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/collection/package.json packages/collection/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/notifications/package.json packages/notifications/package.json
COPY packages/security/package.json packages/security/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app /app
USER node

EXPOSE 3000 3001
CMD ["node", "apps/api/dist/index.js"]
