# Deploying the UUAIS Mattermost AI Agent

Three supported paths. The Mastra build is self-contained: `bun run build` produces
`apps/agent/.mastra/output/` with its own `node_modules`, so deployment is just
"run `node index.mjs`" with the right env vars.

## Prerequisites (before any path)

1. A Mattermost bot account created by a System Admin on `chat.aisociety.se`
   (System Console → Integrations → Bot Accounts → enable creation → add bot).
   Save the one-time token.
2. `apps/agent/.env` populated — see `.env.example`:
   - `MATTERMOST_BASE_URL=https://chat.aisociety.se`
   - `MATTERMOST_BOT_TOKEN=<from admin>`
   - `OPENROUTER_API_KEY=...`
   - `GITHUB_TOKEN=...` (optional, for GitHub org tools)
   - `MCP_ADMIN_TOKEN=...` (optional, for UUAIS website data tools; must match the
     website's `MCP_ADMIN_TOKEN`) and `MCP_URL=https://uuais.com/api/mcp` (default)
3. A VPS (see repo README for recommendations — Hetzner `cax11` / `cx23` ≈ €4/mo
   is plenty for this workload).
4. Invite the bot to the channels it should answer in (`/invite @uuais-ai`).

## Option A — Docker (recommended)

```bash
cd mattermost-ai-agent
docker build -t uuais-mattermost-agent -f deploy/Dockerfile .
docker run -d \
  --name uuais-mattermost-agent \
  --restart unless-stopped \
  --env-file apps/agent/.env \
  -v uuais-agent-data:/data \
  -p 4111:4111 \
  uuais-mattermost-agent
```

- Agent state (LibSQL: channel subscriptions + memory) persists in the
  `uuais-agent-data` volume.
- Port 4111 only needs to be exposed if you use interactive cards (Mattermost
  callback URL). For plain @mention/DM replies the bot connects **out** to
  Mattermost, so no inbound port is required.

## Option B — bare-metal systemd (no Docker)

1. Build on the VPS:
   ```bash
   cd /opt/mattermost-ai-agent && bun install && cd apps/agent && bun run build
   ```
2. Install the unit and enable it:
   ```bash
   sudo cp deploy/uuais-mattermost-agent.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now uuais-mattermost-agent
   ```
3. Logs: `journalctl -u uuais-mattermost-agent -f`

## Option C — Raspberry Pi on a home network

See [`raspberry-pi.md`](./raspberry-pi.md). The agent only makes outbound
connections, so a Pi behind NAT needs no port forwarding, dynamic DNS or TLS.
Note that you must build on the Pi itself — the dependency tree contains
architecture-specific native binaries, so a build copied from an x86 machine
fails at runtime.

## Health check

The Mastra server exposes an HTTP server on port 4111. To confirm it's up:

```bash
curl -s http://localhost:4111/api/agents/mattermost-agent/channels/mattermost/webhook
```

A 4xx/5xx is fine — it means the server answered. Then DM or @mention the bot
in Mattermost and confirm it replies.

## Updating

```bash
git pull
bun install          # or bun install --frozen-lockfile
cd apps/agent && bun run build
# restart: docker restart uuais-mattermost-agent
#          systemctl restart uuais-mattermost-agent
```
