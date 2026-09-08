// Compact stand-ins for the GitHub MCP server's `issues` and `pull_requests`
// toolsets, which cost ~8,100 tokens of schema for 8 tools. These three cover
// what members actually ask and cost a fraction of that, so the descriptions
// are deliberately terse.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { GITHUB_ORG } from "../mcp/github-mcp";

const API = "https://api.github.com";

function token(): string | null {
  return process.env.GITHUB_TOKEN?.trim() || null;
}

export function githubExtraAvailable(): boolean {
  return token() !== null;
}

async function gh<T>(path: string): Promise<T> {
  const key = token();
  if (!key) throw new Error("GITHUB_TOKEN is not set.");
  const response = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    if (response.status === 404) throw new Error(`Not found (or private): ${path}`);
    throw new Error(`GitHub ${response.status} on ${path}`);
  }
  return (await response.json()) as T;
}

/** Keep only the fields worth spending context on. */
type Item = {
  number: number;
  title: string;
  state: string;
  user?: { login?: string };
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  draft?: boolean;
  pull_request?: unknown;
  body?: string;
};

const brief = (i: Item) => ({
  number: i.number,
  title: i.title,
  state: i.state,
  author: i.user?.login ?? null,
  updated: i.updated_at ?? null,
  url: i.html_url ?? null,
});

const repoParam = z.string().describe(`Repo name within the ${GITHUB_ORG} org`);
const stateParam = z.enum(["open", "closed", "all"]).optional().describe("Default open");
const limitParam = z.number().int().min(1).max(50).optional().describe("Default 15");

export const githubIssues = createTool({
  id: "github_issues",
  description: `List issues in a ${GITHUB_ORG} repo. Pull requests are excluded.`,
  inputSchema: z.object({ repo: repoParam, state: stateParam, limit: limitParam }),
  execute: async ({ repo, state, limit }) => {
    const items = await gh<Item[]>(
      `/repos/${GITHUB_ORG}/${repo}/issues?state=${state ?? "open"}&per_page=${limit ?? 15}`,
    );
    // The issues endpoint returns PRs too; callers asked for issues.
    const issues = items.filter((i) => !i.pull_request);
    return { repo, count: issues.length, issues: issues.map(brief) };
  },
});

export const githubPulls = createTool({
  id: "github_pulls",
  description: `List pull requests in a ${GITHUB_ORG} repo.`,
  inputSchema: z.object({ repo: repoParam, state: stateParam, limit: limitParam }),
  execute: async ({ repo, state, limit }) => {
    const items = await gh<Item[]>(
      `/repos/${GITHUB_ORG}/${repo}/pulls?state=${state ?? "open"}&per_page=${limit ?? 15}`,
    );
    return {
      repo,
      count: items.length,
      pulls: items.map((i) => ({ ...brief(i), draft: i.draft ?? false })),
    };
  },
});

export const githubThread = createTool({
  id: "github_thread",
  description: `Read one issue or PR in a ${GITHUB_ORG} repo, with its comments.`,
  inputSchema: z.object({
    repo: repoParam,
    number: z.number().int().describe("Issue or PR number"),
  }),
  execute: async ({ repo, number }) => {
    const [item, comments] = await Promise.all([
      gh<Item>(`/repos/${GITHUB_ORG}/${repo}/issues/${number}`),
      gh<{ user?: { login?: string }; created_at?: string; body?: string }[]>(
        `/repos/${GITHUB_ORG}/${repo}/issues/${number}/comments?per_page=30`,
      ),
    ]);
    return {
      ...brief(item),
      is_pull_request: !!item.pull_request,
      body: (item.body ?? "").slice(0, 6000),
      comments: comments.map((c) => ({
        author: c.user?.login ?? null,
        at: c.created_at ?? null,
        body: (c.body ?? "").slice(0, 2000),
      })),
    };
  },
});

export const githubExtraTools = {
  github_issues: githubIssues,
  github_pulls: githubPulls,
  github_thread: githubThread,
};
