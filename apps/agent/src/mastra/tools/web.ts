// Web search tools. Distinct from the uuais_* tools: those read our own site's
// database and are authoritative about UUAIS; these read the open web.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { answer, findSimilar, readUrls, search, webSearchConfigured } from "../web/exa";

function requireWeb(): void {
  if (!webSearchConfigured()) throw new Error("Web search is not configured (EXA_API_KEY).");
}

export const webSearch = createTool({
  id: "web_search",
  description:
    "Search the open web and get back titles, links and short excerpts. Use for " +
    "anything outside UUAIS — papers, tooling, external events, company " +
    "background before an outreach meeting. For facts about UUAIS itself, use " +
    "the uuais_* tools instead: they read our own data and are authoritative.",
  inputSchema: z.object({
    query: z.string().describe("A full-sentence query works better than keywords."),
    num_results: z.number().int().min(1).max(10).optional().describe("Default 5"),
    include_domains: z.array(z.string()).optional().describe('e.g. ["arxiv.org"]'),
    exclude_domains: z.array(z.string()).optional(),
    published_after: z.string().optional().describe("ISO date, to exclude stale pages"),
    include_full_text: z
      .boolean()
      .optional()
      .describe("Return page text rather than short highlights. Costs more context."),
  }),
  execute: async ({ query, num_results, include_domains, exclude_domains, published_after, include_full_text }) => {
    requireWeb();
    return search({
      query,
      numResults: num_results,
      includeDomains: include_domains,
      excludeDomains: exclude_domains,
      startPublishedDate: published_after,
      includeText: include_full_text,
    });
  },
});

export const webAnswer = createTool({
  id: "web_answer",
  description:
    "Ask a factual question and get a short sourced answer with citations. Good " +
    "for a single specific fact; use web_search when you want to read around a " +
    "topic or compare sources yourself.",
  inputSchema: z.object({ question: z.string() }),
  execute: async ({ question }) => {
    requireWeb();
    return answer(question);
  },
});

export const webRead = createTool({
  id: "web_read",
  description:
    "Fetch the readable text of specific web pages, up to five URLs. Use after " +
    "web_search when an excerpt is not enough, or when a member pastes a link.",
  inputSchema: z.object({ urls: z.array(z.string()).min(1).max(5) }),
  execute: async ({ urls }) => {
    requireWeb();
    return { pages: await readUrls(urls) };
  },
});

export const webFindSimilar = createTool({
  id: "web_find_similar",
  description:
    "Given a URL, find pages like it. Useful for finding comparable student " +
    "societies, similar events, or more work by the same group.",
  inputSchema: z.object({
    url: z.string(),
    num_results: z.number().int().min(1).max(10).optional(),
  }),
  execute: async ({ url, num_results }) => {
    requireWeb();
    return { results: await findSimilar(url, num_results) };
  },
});

export const webTools = {
  web_search: webSearch,
  web_answer: webAnswer,
  web_read: webRead,
  web_find_similar: webFindSimilar,
};
