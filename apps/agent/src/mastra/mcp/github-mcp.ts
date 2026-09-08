import { MCPClient } from "@mastra/mcp";

const token = process.env.GITHUB_TOKEN;

if (!token) {
  console.warn(
    "[github-mcp] GITHUB_TOKEN is not set — GitHub MCP tools will be disabled. " +
      "Create a fine-grained PAT with public-repo read access and set GITHUB_TOKEN " +
      "Set GITHUB_TOKEN in apps/agent/.env to enable scanning of the uuaisociety GitHub organization.",
  );
}

// Read-only GitHub MCP server (https://github.com/github/github-mcp-server); org scoping enforced in agent instructions + token perms.
export const githubMcp = token
  ? new MCPClient({
      id: "github-mcp",
      servers: {
        github: {
          url: new URL("https://api.githubcopilot.com/mcp/"),
          requestInit: {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-MCP-Readonly": "true",
              // issues and pull_requests are omitted: their 8 tools cost about
              // 8,100 tokens of schema, and tools/github-extra.ts covers the
              // same ground in a fraction of that.
              "X-MCP-Toolsets": "repos,search,users,context",
            },
          },
        },
      },
    })
  : undefined;

export const GITHUB_ORG = process.env.GITHUB_ORG ?? "uuaisociety";
