# AGENTS.md

Guidance for AI coding agents working in this repository. Read this before making changes.

## What this project is

**UUAIS Mattermost AI Agent** — a [Mastra](https://mastra.ai) agent that runs as a bot inside UUAIS's Mattermost workspace (`chat.aisociety.se`). Users @mention the bot or DM it; the agent replies through Mastra's normal pipeline (model → tools → memory).

The Mattermost integration uses Mastra's **channels** feature (`@mastra/core@1.22.0`+) combined with the community [`chat-adapter-mattermost`](https://www.npmjs.com/package/chat-adapter-mattermost) package from the [Chat SDK](https://chat-sdk.dev/adapters) ecosystem. The default model routes through **OpenRouter** (`openrouter/deepseek/deepseek-v4-flash-0731`); change the `model` string in `apps/agent/src/mastra/agents/mattermost-agent.ts` to swap providers.

## Repo layout

- Bun workspaces monorepo. Root scripts proxy to `apps/agent`.
- `apps/agent/src/mastra/index.ts` — the `Mastra` instance. Register every agent here.
- `apps/agent/src/mastra/agents/` — one file per `Agent` (e.g. `weather-agent.ts`).
- `apps/agent/src/mastra/tools/` — one file per tool created with `createTool({...})`.
- `apps/agent/.env` — secrets (Mattermost token, model keys, `DATABASE_URL`). Never commit real values.

## Stack and conventions

- **Runtime:** Bun `>=1.2.0`, Node.js `>=20` (required by the Mattermost adapter).
- **Language:** TypeScript, ES modules (`"type": "module"`).
- **Install/run:** `bun install`, `bun run dev`, `bun run build` from repo root. Do **not** introduce `npm`, `pnpm`, or `yarn` lockfiles.
- **Framework:** Mastra. Use the `mastra` skill at `.claude/skills/mastra/SKILL.md` for current API signatures before writing framework code — the API moves fast and outdated patterns will fail silently.
- **Model strings:** Use Mastra's string shorthand (`"openrouter/deepseek/deepseek-v4-flash-0731"`, `"openrouter/openai/gpt-5.4-mini"`, etc.) or AI SDK provider factories. Don't hardcode model versions the team hasn't approved.

## Adding an agent

1. Create `apps/agent/src/mastra/agents/<name>-agent.ts` exporting a named `Agent`.
2. If it should appear in Mattermost, configure `channels.adapters.mattermost` with `createMattermostAdapter()` (reads `MATTERMOST_BASE_URL` and `MATTERMOST_BOT_TOKEN` from env by default).
3. Register the agent in `apps/agent/src/mastra/index.ts` under `new Mastra({ agents: { ... } })`.
4. Ensure the `Mastra` instance has persistent `storage` (e.g. `LibSQLStore`) so channel state survives restarts. Without storage, thread subscriptions and memory reset on every restart.

Example skeleton:

```typescript
import { Agent } from '@mastra/core/agent'
import { createMattermostAdapter } from 'chat-adapter-mattermost'

export const supportAgent = new Agent({
  id: 'support-agent',
  name: 'Support Agent',
  instructions: '...',
  model: 'openai/gpt-5.4',
  channels: {
    adapters: { mattermost: createMattermostAdapter() },
  },
})
```

## Adding a tool

- Put it in `apps/agent/src/mastra/tools/<name>-tool.ts` using `createTool` from `@mastra/core/tools`.
- Define `inputSchema` with `zod`. Prefer descriptive `.describe()` on every field so the model picks arguments correctly.
- For destructive or privileged tools, set `requireApproval: true` — it renders as an Approve/Deny card in Mattermost and only executes after the user approves.
- Attach the tool via the agent's `tools: { myTool }` map.

## Mattermost-specific notes

- Webhook route Mastra generates: `/api/agents/{agentId}/channels/mattermost/webhook`. For local dev, tunnel `localhost:4111` with ngrok/cloudflared.
- The adapter connects over REST API v4 + `/api/v4/websocket`. The bot only receives events from channels it is a member of — always remind the user to add the bot.
- Thread IDs are encoded as `mattermost:<base64url(channelId)>[:<base64url(rootPostId)>]`. Don't parse or synthesize them manually; use adapter APIs.
- First mention in a thread auto-fetches the last 10 messages for context. Disable with `threadContext: { maxMessages: 0 }` when that's inappropriate (e.g. sensitive tools).
- Multi-user messages arrive prefixed with `[Name (@userId)]:`. Agent instructions should expect this format in group channels.

## Feature-support reality check

Before promising a Mattermost behaviour, verify it against the adapter's support matrix:

- Fully supported: posting/editing/deleting, DMs, reactions, ephemeral messages, typing indicators.
- Partial: file uploads (no edit-with-upload), cards (fallback to text + attachments), streaming (post-and-edit only), error handling (no rate-limit surface).
- **Not supported:** modals, slash commands, and full interactive-action lifecycles. Don't build features that depend on these without discussing with the user first.

## Do / Don't

Do:

- Use the `mastra` skill and read current docs before writing Mastra code.
- Keep secrets out of source. Reference `process.env.*` and document new vars in `README.md`.
- Follow the `page.tsx` user rule when creating Next.js pages (import and re-export a named component).
- Run the `react-doctor` skill after React changes.

Don't:

- Don't add a second package manager's lockfile.
- Don't bypass the adapter to call Mattermost REST endpoints directly unless there's no Mastra-level abstraction.
- Don't commit `apps/agent/.env` or any bot token.
- Don't generate `README.md` "narration" comments in code.

## References

- [Mastra channels docs](https://mastra.ai/docs/agents/channels)
- [Channels reference](https://mastra.ai/reference/agents/channels)
- [Chat SDK adapters](https://chat-sdk.dev/adapters)
- [`chat-adapter-mattermost`](https://www.npmjs.com/package/chat-adapter-mattermost)
