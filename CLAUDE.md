# CLAUDE.md

This file is the entry point for Claude Code. All project guidance for AI coding agents lives in [`AGENTS.md`](./AGENTS.md) — read that file first and follow it.

Quick orientation:

- **Project:** UUAIS Mattermost AI Agent — a [Mastra](https://mastra.ai) agent that runs as a bot in Mattermost via Mastra's `channels` feature (`@mastra/core@1.22.0`+) and the community [`chat-adapter-mattermost`](https://www.npmjs.com/package/chat-adapter-mattermost) package. Default model routed through OpenRouter (`openrouter/deepseek/deepseek-v4-flash-0731`).
- **Stack:** Bun workspaces monorepo, TypeScript ESM, Node.js `>=20`, Bun `>=1.2.0`.
- **Entry point:** `apps/agent/src/mastra/index.ts` registers every `Agent` on the `Mastra` instance.
- **Run:** `bun install && bun run dev` from the repo root.

Before writing Mastra code, read `.claude/skills/mastra/SKILL.md` to verify current APIs — the framework changes quickly.

See [`README.md`](./README.md) for end-user setup (bot account, env vars, webhook URLs) and the Mattermost adapter feature-support matrix.
