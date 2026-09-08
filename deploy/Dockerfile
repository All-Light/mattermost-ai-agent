# UUAIS Mattermost AI Agent — production image
# Build:  docker build -t uuais-mattermost-agent -f deploy/Dockerfile .
# Run:    docker run --env-file apps/agent/.env uuais-mattermost-agent

# Stage 1: build the Mastra bundle (needs Bun + full repo)
FROM oven/bun:1.2-alpine AS build
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY apps/agent/package.json ./apps/agent/package.json
RUN bun install --frozen-lockfile

COPY apps/agent ./apps/agent
# Mastra's build self-installs into .mastra/output with its own node_modules.
RUN cd apps/agent && bun run build

# Stage 2: minimal runtime — just Node + the build output
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Persist Mastra channel/memory state across container restarts.
ENV DATABASE_URL=file:/data/mastra.db
RUN mkdir -p /data && chown -R node:node /data

COPY --from=build --chown=node:node /app/apps/agent/.mastra/output /app/

USER node
EXPOSE 4111

# Mastra start runs an Hono server (webhooks, Studio). The Mattermost adapter
# connects out over REST v4 + WebSocket, so no extra inbound config is needed
# unless you use interactive cards (then expose 4111 behind TLS).
CMD ["node", "index.mjs"]
