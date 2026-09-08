# UUAIS Mattermost AI Agent

An AI agent for [Uppsala University AI Society (UUAIS)](https://uuais.com) that lives inside our Mattermost workspace at `chat.aisociety.se`. We use Mattermost as our main communication platform and want an agent we can @mention in channels and DMs to help with questions, tasks, and automations. The default model is routed through [OpenRouter](https://openrouter.ai).

## What this is

The agent is built with [Mastra](https://mastra.ai) and connects to Mattermost through Mastra's **channels** feature (available in `@mastra/core@1.22.0`+). Channels wire an agent up to a messaging platform so that:

1. A user sends a message or mentions the bot on Mattermost.
2. Mastra forwards it through the normal agent pipeline (model, tools, memory).
3. The response is streamed back into the conversation or thread.

Mattermost support comes from the community [`chat-adapter-mattermost`](https://www.npmjs.com/package/chat-adapter-mattermost) package (from the [Chat SDK](https://chat-sdk.dev/adapters) ecosystem), which talks to Mattermost over REST API v4 and the `/api/v4/websocket` gateway.

## Project structure

```text
mattermost-ai-agent/
├── apps/
│   └── agent/                # Mastra app (entry point: bun run dev)
│       └── src/mastra/
│           ├── index.ts      # Mastra instance + agent registration
│           ├── agents/       # Agent definitions
│           └── tools/        # Tool definitions (createTool)
├── packages/                 # Shared workspace packages (if any)
└── package.json              # Bun workspaces root
```

This is a Bun workspaces monorepo. All dev/build commands are proxied through the root `package.json`:

```bash
bun install
bun run dev        # runs apps/agent in dev mode
bun run build      # builds apps/agent

bun run mm:up      # start a local Mattermost server in Docker
bun run mm:logs    # tail Mattermost logs
bun run mm:down    # stop (Docker volumes keep your data)
bun run mm:reset   # stop AND wipe volumes for a clean install
```

Requires **Bun >= 1.2.0**, **Node.js >= 20** (for the Mattermost adapter's runtime deps), and **Docker Desktop** if you want to run Mattermost locally.

## Local Mattermost for development

If you don't have admin rights on the UUAIS Mattermost, run your own for development. The repo ships a Docker Compose stack at [`docker/docker-compose.yml`](./docker/docker-compose.yml) with Mattermost Team Edition + Postgres and bot account creation pre-enabled.

```bash
bun run mm:up
```

First start takes ~1 min (image pull; on Apple Silicon the Mattermost image runs under Rosetta emulation). When the container is healthy:

1. Open `http://localhost:8065` and create the initial **admin** account (first signup becomes the admin).
2. Create a team (e.g. `uuais-dev`).
3. Open the product menu (top-left) → **Integrations** → **Bot Accounts** → **Add Bot Account**. Give it a username like `uuais-ai`, create it, and **copy the access token from the one-time screen**.
4. Paste into `apps/agent/.env`:

   ```bash
   MATTERMOST_BASE_URL=http://localhost:8065
   MATTERMOST_BOT_TOKEN=<the-token-you-just-copied>
   ```

5. Invite the bot into any channel with `/invite @uuais-ai` (or open a DM with it).
6. Start the agent with `bun run dev` and @mention the bot or DM it.

Data lives in named Docker volumes (`mm-config`, `mm-data`, `postgres-data`, etc.) and survives `mm:down`. Use `mm:reset` when you want a completely fresh Mattermost install.

## How channels work here

An agent opts into a platform by adding an adapter under `channels.adapters`:

```typescript
import { Agent } from '@mastra/core/agent'
import { createMattermostAdapter } from 'chat-adapter-mattermost'

export const supportAgent = new Agent({
  id: 'support-agent',
  name: 'Support Agent',
  instructions: 'You are a helpful UUAIS assistant.',
  model: 'openrouter/deepseek/deepseek-v4-flash-0731',
  channels: {
    adapters: {
      mattermost: createMattermostAdapter({
        baseUrl: process.env.MATTERMOST_BASE_URL!,
        botToken: process.env.MATTERMOST_BOT_TOKEN!,
      }),
    },
  },
})
```

The adapter reads `MATTERMOST_BASE_URL` and `MATTERMOST_BOT_TOKEN` from the environment by default, so `createMattermostAdapter()` with no arguments works once those are set.

Register the agent on the Mastra instance with persistent storage so channel state (thread subscriptions, memory) survives restarts:

```typescript
import { Mastra } from '@mastra/core'
import { LibSQLStore } from '@mastra/libsql'
import { supportAgent } from './agents/support-agent'

export const mastra = new Mastra({
  agents: { supportAgent },
  storage: new LibSQLStore({ url: process.env.DATABASE_URL }),
})
```

Mastra auto-generates a webhook route per platform at:

```text
/api/agents/{agentId}/channels/{platform}/webhook
```

For local development, expose `localhost:4111` with ngrok or cloudflared and point Mattermost's interactive callback URL at the tunnel.

## Mattermost setup

1. **Create a bot account** — In Mattermost, go to **System Console → Integrations → Bot Accounts** and create a bot. Copy the generated access token into `MATTERMOST_BOT_TOKEN`.
2. **Enable integrations** — Bot accounts, REST API, and the WebSocket gateway must be enabled (default on most installs).
3. **Add the bot to channels** — The bot only receives events from channels it is a member of.
4. **(Optional) Interactive actions** — For buttons/selects, set `callbackUrl` on the adapter to a public URL and register it in **System Console → Integrations → Interactive Dialogs**.

## Environment variables

Create `apps/agent/.env` with at least:

```bash
# Mattermost
MATTERMOST_BASE_URL=https://chat.aisociety.se
MATTERMOST_BOT_TOKEN=your-bot-token

# Model provider (OpenRouter — get a key at https://openrouter.ai/keys)
OPENROUTER_API_KEY=...

# Mastra storage
DATABASE_URL=file:./mastra.db

# GitHub MCP (read-only access to the uuaisociety org)
GITHUB_TOKEN=...
GITHUB_ORG=uuaisociety

# UUAIS website MCP (read-only site data; token must match the website's)
MCP_ADMIN_TOKEN=...
MCP_URL=https://www.uuais.com/api/mcp

# UUAIS Business Hub / CRM MCP (token must match the Business Hub's MCP_API_TOKEN)
CRM_MCP_TOKEN=...
CRM_MCP_URL=https://uuaibiz.vercel.app/api/mcp

# Shared Google Calendar (service account; see "Shared Google Calendar" below)
GOOGLE_CALENDAR_ID=...@group.calendar.google.com
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=~/.config/uuais/uuais-bot-key.json
```

## OpenRouter (default model provider)

The agent talks to models through [OpenRouter](https://openrouter.ai), which gives you one API key for 400+ models from every major provider (OpenAI, Anthropic, Google, DeepSeek, and more) with a single OpenAI-compatible endpoint. Mastra ships OpenRouter as a **native provider**, so you only need to:

1. Create an account at [openrouter.ai](https://openrouter.ai) and add credit.
2. Copy your key at [openrouter.ai/keys](https://openrouter.ai/keys) into `OPENROUTER_API_KEY` in `apps/agent/.env`.
3. Point the agent's `model` field at any OpenRouter slug, e.g. `openrouter/deepseek/deepseek-v4-flash-0731`.

No other config is needed — Mastra's model router resolves the `openrouter/<model>` string and sends the `Authorization: Bearer` header automatically. To switch models, just change the `model` string in `apps/agent/src/mastra/agents/mattermost-agent.ts` and restart.

Useful OpenRouter features you can enable per request (check current Mastra/OpenRouter docs before relying on them):
- `:online` suffix for web search (`openrouter/deepseek/deepseek-v4-flash-0731:online`)
- `:free` / `:nitro` / `:floor` routing variants for cheap or fast endpoints
- Model routing fallbacks — OpenRouter auto-retries on other providers if one is down

## UUAIS website data (MCP endpoint)

The agent answers real questions about the society by connecting to the MCP server hosted by the UUAIS website at `GET/POST /api/mcp` (a Next.js route backed by the website's Firestore). All tools are read-only. Fourteen are exposed:

**Content**
- `uuais_getUuaisEvents` — upcoming/past events, dates, locations, registration
- `uuais_getUuaisBlogPosts` / `uuais_getUuaisBlogPostById` — news and articles
- `uuais_getUuaisFaqs` — canonical FAQ answers
- `uuais_getUuaisTeam` — board and team members
- `uuais_getUuaisJobs` — job/internship/thesis opportunities
- `uuais_getUuaisBoard` — open board positions and application campaigns
- `uuais_getUuaisCourses` / `uuais_getUuaisCourseById` — course directory and full details

**Analysis & discovery**
- `uuais_getUuaisOverview` — compact snapshot of everything (first stop for broad questions)
- `uuais_searchUuaisContent` — search across all site content at once
- `uuais_getUuaisCourseAnalysis` — a course's level, credits, prerequisites, dependents, and related courses
- `uuais_getUuaisAnalytics` — engagement stats (most-clicked events/jobs, most-read posts)
- `uuais_getUuaisSiteStats` — counts of everything on the site

To enable them, set the same shared secret the website uses (`apps/agent/.env`):

```bash
MCP_ADMIN_TOKEN=...   # must equal the website's MCP_ADMIN_TOKEN
MCP_URL=https://www.uuais.com/api/mcp   # override for local dev (e.g. http://localhost:3000/api/mcp)
```

If the variables are missing, the tools log a warning and are disabled — everything else keeps working.

## UUAIS Business Hub / CRM (MCP endpoint)

The agent reads — and, when enabled, writes — the society's internal CRM at
[uuaibiz.vercel.app](https://uuaibiz.vercel.app) (repo:
[`Williyami/UUAIbiz`](https://github.com/Williyami/UUAIbiz)) through an MCP
endpoint the Business Hub exposes at `POST /api/mcp`. Twelve tools:

**Read** — `crm_list_team`, `crm_list_tasks`, `crm_list_events`,
`crm_list_meetings`, `crm_list_companies`, `crm_list_contacts`,
`crm_upcoming` (one digest of everything due in the next N days),
`crm_search` (free text across every module).

**Write** — `crm_create_task`, `crm_update_task`, `crm_create_event`,
`crm_update_event`.

Whether the write tools exist at all is decided by the Business Hub, not here:
with `MCP_ALLOW_WRITES` unset on that side they are neither advertised nor
callable. The agent's instructions additionally require it to state any write
back to the requester and get a yes before calling.

```bash
CRM_MCP_TOKEN=...                                   # = the Business Hub's MCP_API_TOKEN
CRM_MCP_URL=https://uuaibiz.vercel.app/api/mcp      # override for local dev
```

Missing token or unreachable endpoint → the tools log a warning and disable
themselves; everything else keeps working. Setup on the CRM side is documented
in that repo's `docs/mcp-api.md`.

Assignees can be passed as a name, an email or an id — the server resolves them
against the Business Hub's `profiles` table. Email is the join key between the
two systems: a Business Hub account and a Mattermost account share it, while
usernames may differ.

## Reminders and reaching members

The bot can message a member unprompted, which the chat adapter alone does not
allow — these tools use Mattermost's REST API directly
(`apps/agent/src/mastra/mattermost/rest.ts`).

| Tool | Behaviour |
| --- | --- |
| `remind_member` | Schedules a DM for a future time |
| `message_member` | Sends a DM now — **requires approval**, rendered as an Approve/Deny card |
| `list_reminders` | Scheduled reminders, soonest first |
| `cancel_reminder` | Cancels a pending one |

Recipients are given as `@username`, a bare username, or an email address.
Unknown recipients fail at scheduling time, not at delivery time, so a typo
surfaces while someone is still there to fix it.

Reminders are stored in the `agent_reminders` table in the same LibSQL database
as agent memory, so they survive restarts and redeploys. A background sweep
(`apps/agent/src/mastra/reminders/scheduler.ts`) runs every 30 seconds,
delivers what is due, and retries up to three times before marking a reminder
failed. It starts with the Mastra instance, so reminders fire whether or not
anyone is talking to the bot.

Times without a timezone are read as **Europe/Stockholm** wall-clock time —
"tomorrow at 09:00" means 09:00 in Uppsala, in both summer and winter
(`apps/agent/src/mastra/reminders/time.ts`).

## Shared Google Calendar

The bot manages one shared UUAIS calendar: `list_calendar_events`,
`create_calendar_event`, `update_calendar_event`, `delete_calendar_event`.

```bash
GOOGLE_CALENDAR_ID=...@group.calendar.google.com
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=~/.config/uuais/uuais-bot-key.json
# or, better for container deploys, inline (keep the literal \n escapes):
# GOOGLE_SERVICE_ACCOUNT_EMAIL=uuais-bot@uuais-agent.iam.gserviceaccount.com
# GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
```

Unset either and the tools disable themselves with a warning, like the other
integrations.

### How access is scoped

The service account (`uuais-bot@uuais-agent.iam.gserviceaccount.com`) holds
**no IAM roles on any GCP project** — enabling the Calendar API granted it
nothing. Its entire reach comes from four independent limits:

| Layer | Limit | Where |
| --- | --- | --- |
| Calendar sharing | "Make changes to events" on one calendar — cannot re-share it or change its ACL | Google Calendar settings |
| OAuth scope | `calendar.events` — event CRUD only, no ACL access, no calendar list | `google/calendar.ts` |
| Calendar id | Pinned from `GOOGLE_CALENDAR_ID`; never a tool parameter | `google/calendar.ts` |
| Provenance | Events the bot creates are tagged `createdBy: uuais-mattermost-agent` | `google/calendar.ts` |

That last one drives the approval behaviour: `delete_calendar_event` always
requires approval **and** refuses events the bot did not create, while
`update_calendar_event` only interrupts a human when the event was added by
hand (conditional `requireApproval`).

### Key rotation — this will expire

Key creation is blocked org-wide on `uuais.com` by
`constraints/iam.disableServiceAccountKeyCreation`. The `uuais-agent` project
carries a scoped exception, plus `iam.serviceAccountKeyExpiryHours = 2160h`, so
**keys expire after 90 days**. The current key expires **2026-12-06**, after
which calendar tools start failing with an access-denied message.

To rotate:

```bash
SA=uuais-bot@uuais-agent.iam.gserviceaccount.com
gcloud iam service-accounts keys list --iam-account=$SA --managed-by=user
gcloud iam service-accounts keys delete <OLD_KEY_ID> --iam-account=$SA
gcloud iam service-accounts keys create ~/.config/uuais/uuais-bot-key.json --iam-account=$SA
```

Then redeploy the agent with the new key. Put a reminder in the calendar — the
bot can set one for itself once it is running.

## Rate limiting

A per-user sliding-window limiter guards the bot against abuse (a script or runaway loop burning model credits). Limits are generous enough that a regular member never notices them:

- **20 messages/minute** and **300 messages/day** per user (defaults)
- On refusal, the bot posts a short polite notice instead of spending a model call
- Bots and the agent's own messages are exempt

Tune via `apps/agent/.env`:

```bash
RATE_LIMIT_PER_MINUTE=20
RATE_LIMIT_PER_DAY=300
```

Implementation: `apps/agent/src/mastra/channels/rate-limit.ts` (in-memory sliding window).

## GitHub access (official GitHub MCP server)

The agent connects to the remote [GitHub MCP server](https://github.com/github/github-mcp-server) at `https://api.githubcopilot.com/mcp/` through Mastra's `MCPClient` (`apps/agent/src/mastra/mcp/github-mcp.ts`). This gives the agent read-only tools to list repos, read files and READMEs, inspect issues and pull requests, and run code / issue / user search scoped to our public organization [`uuaisociety`](https://github.com/uuaisociety).

To enable it:

1. Create a **fine-grained personal access token** at [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
   - **Resource owner:** `uuaisociety`
   - **Repository access:** *Public repositories (read-only)*
   - No additional permissions required — the token just unlocks the 5000 req/hour rate limit.
2. Set `GITHUB_TOKEN` (and optionally override `GITHUB_ORG`) in `apps/agent/.env`.
3. Restart the agent. If `GITHUB_TOKEN` is missing the GitHub tools are silently disabled with a warning; everything else continues to work.

The MCP client is configured with `X-MCP-Readonly: true` and only the `repos,issues,pull_requests,search,users,context` toolsets. If you want to tighten or broaden this, edit `apps/agent/src/mastra/mcp/github-mcp.ts`.

## Feature support (Mattermost adapter)

| Feature               | Status | Notes                                                                 |
| --------------------- | :----: | --------------------------------------------------------------------- |
| Message posting       |   ✅   | Post/edit/delete in channels and threads.                             |
| Overlapping messages  |   ✅   | Stable thread IDs + `lockScope = "thread"`.                           |
| Direct messages       |   ✅   | `openDM()` and `isDM()` implemented.                                  |
| Emoji / reactions     |   ✅   | Outgoing formatting and add/remove handling.                          |
| Ephemeral messages    |   ✅   | Native `/posts/ephemeral` API.                                        |
| Typing indicators     |   ✅   | `startTyping()` sends Mattermost typing events.                       |
| File uploads          |   🟡   | Send/receive works; editing with new uploads not supported.           |
| Cards                 |   🟡   | Rendered as plain text + interactive attachments when `callbackUrl`.  |
| Streaming             |   🟡   | Post-and-edit fallback; no native streaming transport.                |
| Error handling        |   🟡   | Auth/permission/not-found/network mapped; no rate-limit surfacing.    |
| Actions               |   ❌   | Button/select callbacks handled but full lifecycle incomplete.        |
| Modals                |   ❌   | No open/submit flows.                                                 |
| Slash commands        |   ❌   | Not parsed or dispatched.                                             |

Thread IDs are encoded as `mattermost:<base64url(channelId)>` for channel-level contexts, or `mattermost:<base64url(channelId)>:<base64url(rootPostId)>` for threaded replies. User and channel data are cached in-memory with LRU eviction (up to 1000 entries). WebSocket reconnection uses exponential backoff with jitter (1 s base, 30 s max).

## Thread context

When the bot is mentioned mid-thread it has no prior context by default. Mastra fetches the last **10 messages** from Mattermost on the first mention, prepends them to the user message, then subscribes to the thread and uses its own memory for subsequent turns. Disable with `threadContext: { maxMessages: 0 }`.

## Tool approval

Tools marked `requireApproval: true` render as Approve/Deny cards in Mattermost. The tool only runs after approval. Set `cards: false` on the adapter to fall back to plain text; Mastra's `autoResumeSuspendedTools` then lets the LLM decide from conversation context.

## Multi-user awareness

In group channels, Mastra prefixes each incoming message with the sender's name and Mattermost user ID so the agent can tell speakers apart:

```text
[Alice (@u123abc)]: Can you help with this?
[Bob (@u456def)]: I have a follow-up.
```

## Multimodal content

The `channels` config supports `inlineMedia` (mime-type patterns) and `inlineLinks` (domain matchers) to forward images, video, and audio to multimodal models. Default is images only; extend when using vision/audio-capable models.

## References

- [Mastra channels docs](https://mastra.ai/docs/agents/channels)
- [Channels reference](https://mastra.ai/reference/agents/channels)
- [Chat SDK adapters](https://chat-sdk.dev/adapters)
- [`chat-adapter-mattermost` on npm](https://www.npmjs.com/package/chat-adapter-mattermost)

## License

MIT © UUAIS
