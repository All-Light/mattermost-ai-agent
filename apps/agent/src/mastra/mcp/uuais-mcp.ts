import { MCPClient } from "@mastra/mcp";

const token = process.env.MCP_ADMIN_TOKEN;
const rawUrl = process.env.MCP_URL ?? "https://www.uuais.com/api/mcp";

let url: URL | null = null;
try {
  url = new URL(rawUrl);
} catch {
  console.warn(`[uuais-mcp] MCP_URL is not a valid URL ("${rawUrl}") — UUAIS website data tools will be disabled.`);
}

if (!token || !url) {
  console.warn(
    "[uuais-mcp] MCP_ADMIN_TOKEN is not set or MCP_URL is invalid — UUAIS website data tools will be disabled. " +
      "Set MCP_ADMIN_TOKEN (same value as the website's MCP_ADMIN_TOKEN) and optionally " +
      "MCP_URL in apps/agent/.env to enable them.",
  );
}

// Read-only website MCP server (bearer-token protected); disabled with a warning when token/URL invalid.
export const uuaisMcp = token && url
  ? new MCPClient({
      id: "uuais-mcp",
      servers: {
        uuais: {
          url,
          requestInit: {
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
    })
  : undefined;
