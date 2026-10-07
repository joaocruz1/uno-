# syntax=docker/dockerfile:1
# Two runtime targets share one dependency layer:
#   docker build --target web    -t uno-web .
#   docker build --target worker -t uno-worker .
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

# Next.js site, dashboard and public /api/v1 (standalone output).
FROM node:24-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]

# Queue worker, engine subprocess, webhooks, retention and migrations.
FROM base AS worker
ENV NODE_ENV=production TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini tesseract-ocr tesseract-ocr-por tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json drizzle.config.ts ./
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src
USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "tsx", "src/workers/index.ts"]
