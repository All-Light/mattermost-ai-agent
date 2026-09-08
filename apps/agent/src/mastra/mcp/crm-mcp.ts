import { MCPClient } from "@mastra/mcp";

const token = process.env.CRM_MCP_TOKEN;
const rawUrl = process.env.CRM_MCP_URL ?? "https://uuaibiz.vercel.app/api/mcp";

let url: URL | null = null;
try {
  url = new URL(rawUrl);
} catch {
  console.warn(`[crm-mcp] CRM_MCP_URL is not a valid URL ("${rawUrl}") — Business Hub tools will be disabled.`);
}

if (!token || !url) {
  console.warn(
    "[crm-mcp] CRM_MCP_TOKEN is not set or CRM_MCP_URL is invalid — UUAIS Business Hub (CRM) tools will be disabled. " +
      "Set CRM_MCP_TOKEN (same value as the Business Hub's MCP_API_TOKEN) and optionally " +
      "CRM_MCP_URL in apps/agent/.env to enable them.",
  );
}

// Business Hub CRM MCP server (bearer-token protected). Whether the write tools
// are advertised is decided server-side by MCP_ALLOW_WRITES, not here.
export const crmMcp =
  token && url
    ? new MCPClient({
        id: "crm-mcp",
        servers: {
          crm: {
            url,
            requestInit: {
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
      })
    : undefined;
