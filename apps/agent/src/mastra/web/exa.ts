// Web search and page reading via Exa (https://exa.ai).
//
// Plain REST rather than a client library or an MCP hop: three endpoints, one
// header, and it keeps the result shaping here where the context budget is
// actually spent. Neural searches are billed per call, so every entry point
// clamps the number of results and the amount of text returned.
const API_BASE = "https://api.exa.ai";

const MAX_RESULTS = 10;
const MAX_TEXT_CHARS = 4000;

function apiKey(): string | null {
  return process.env.EXA_API_KEY?.trim().replace(/^["']|["']$/g, "") || null;
}

export function webSearchConfigured(): boolean {
  return apiKey() !== null;
}

async function exa<T>(path: string, body: unknown): Promise<T> {
  const key = apiKey();
  if (!key) throw new Error("Web search is not configured (EXA_API_KEY).");

  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    if (response.status === 401) throw new Error("Exa rejected the API key (EXA_API_KEY).");
    if (response.status === 429) throw new Error("Exa rate limit reached — try again shortly.");
    throw new Error(`Exa ${path} failed (${response.status}): ${detail}`);
  }
  return (await response.json()) as T;
}

type ExaResult = {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  text?: string;
  highlights?: string[];
};

/** Trim to what the model needs, so a search does not eat the context window. */
function shape(results: ExaResult[] = []) {
  return results.map((r) => ({
    title: r.title ?? "(untitled)",
    url: r.url ?? null,
    published: r.publishedDate ?? null,
    author: r.author ?? null,
    excerpt: (r.highlights?.join(" … ") || r.text || "").slice(0, 1200).trim() || null,
  }));
}

export function clampResults(n: unknown, fallback = 5): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.trunc(v), 1), MAX_RESULTS);
}

export async function search(opts: {
  query: string;
  numResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  startPublishedDate?: string;
  includeText?: boolean;
}) {
  const body: Record<string, unknown> = {
    query: opts.query,
    numResults: clampResults(opts.numResults),
    type: "auto",
    contents: opts.includeText
      ? { text: { maxCharacters: MAX_TEXT_CHARS } }
      : { highlights: { numSentences: 3, highlightsPerUrl: 2 } },
  };
  if (opts.includeDomains?.length) body.includeDomains = opts.includeDomains;
  if (opts.excludeDomains?.length) body.excludeDomains = opts.excludeDomains;
  if (opts.startPublishedDate) body.startPublishedDate = opts.startPublishedDate;

  const data = await exa<{ results?: ExaResult[]; costDollars?: { total?: number } }>("/search", body);
  return { results: shape(data.results), cost_usd: data.costDollars?.total ?? null };
}

export async function readUrls(urls: string[]) {
  const data = await exa<{ results?: ExaResult[] }>("/contents", {
    urls: urls.slice(0, 5),
    text: { maxCharacters: MAX_TEXT_CHARS },
  });
  return (data.results ?? []).map((r) => ({
    url: r.url ?? null,
    title: r.title ?? null,
    published: r.publishedDate ?? null,
    text: (r.text ?? "").slice(0, MAX_TEXT_CHARS),
  }));
}

export async function answer(query: string) {
  const data = await exa<{ answer?: string; citations?: ExaResult[] }>("/answer", {
    query,
    text: false,
  });
  return {
    answer: data.answer ?? null,
    sources: (data.citations ?? []).map((c) => ({ title: c.title ?? null, url: c.url ?? null })),
  };
}

export async function findSimilar(url: string, numResults?: number) {
  const data = await exa<{ results?: ExaResult[] }>("/findSimilar", {
    url,
    numResults: clampResults(numResults),
    contents: { highlights: { numSentences: 2, highlightsPerUrl: 1 } },
  });
  return shape(data.results);
}
