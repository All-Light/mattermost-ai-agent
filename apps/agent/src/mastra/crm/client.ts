// UUAIS Business Hub (CRM) — read-only access to its Postgres over the Supabase
// Data API (PostgREST).
//
// Plain REST rather than @supabase/supabase-js: the only thing the client
// library adds over fetch here is token refresh, which is a dozen lines, and
// avoiding the dependency keeps the bundle and the audit surface small.
//
// Three behaviours of this API drive the whole design, all documented in the
// Business Hub API handover (verified 17 Sep 2026):
//
//  1. A request without an Authorization header returns `[]` and HTTP 200 —
//     not 401. A dropped token therefore looks exactly like an empty table, so
//     every request here refuses to leave without a bearer token rather than
//     letting the agent report "no results" when it never authenticated.
//  2. Access tokens last about an hour. They are cached, refreshed a minute
//     early, and a 401 mid-flight retries once against a fresh token.
//  3. The account is `viewer` and writes are refused by row-level security
//     inside the database. Only GET is implemented, so a write cannot be
//     attempted by accident.
import { TABLES, type TableName, columnsOf, isTable } from "./schema";

const DEFAULT_ENDPOINT = "";
const DEFAULT_EMAIL = "api@uuais.com";

/** Refresh this long before the token actually expires. */
const EXPIRY_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 15_000;
/** Transient-failure retries (network, 5xx, 429), excluding the 401 refresh. */
const MAX_RETRIES = 2;

/** Ceiling on rows returned to the model, whatever a caller asks for. */
export const MAX_ROWS = 200;

function env(name: string): string | null {
  // Tolerate the quoting and stray whitespace that creeps into hand-edited
  // .env files; a leading space in a URL is otherwise a baffling failure.
  return process.env[name]?.trim().replace(/^["']+|["']+$/g, "").trim() || null;
}

type Config = { endpoint: string; apiKey: string; email: string; password: string };

function readConfig(): Config | null {
  const apiKey = env("CRM_SUPABASE_PUBLISHABLE_KEY");
  const password = env("CRM_PASSWORD");
  if (!apiKey || !password) return null;

  const endpoint = (env("CRM_SUPABASE_ENDPOINT") ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  try {
    new URL(endpoint);
  } catch {
    return null;
  }
  return { endpoint, apiKey, email: env("CRM_EMAIL") ?? DEFAULT_EMAIL, password };
}

export function crmConfigured(): boolean {
  return readConfig() !== null;
}

function config(): Config {
  const c = readConfig();
  if (!c) {
    throw new Error(
      "The Business Hub CRM is not configured — set CRM_SUPABASE_PUBLISHABLE_KEY and CRM_PASSWORD " +
        "(and optionally CRM_SUPABASE_ENDPOINT / CRM_EMAIL) in apps/agent/.env.",
    );
  }
  return c;
}

// --- Authentication -------------------------------------------------------

let cached: { token: string; expiresAt: number } | null = null;
// Concurrent tool calls share one login rather than racing four of them.
let pending: Promise<string> | null = null;

async function login(c: Config): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${c.endpoint}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: c.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: c.email, password: c.password }),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Could not reach the Business Hub to sign in: ${message(error)}`);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    if (response.status === 400 || response.status === 401) {
      throw new Error(
        `The Business Hub rejected the API credentials for ${c.email} — check CRM_PASSWORD and ` +
          "CRM_SUPABASE_PUBLISHABLE_KEY, or ask William to confirm the account is still active.",
      );
    }
    throw new Error(`Business Hub sign-in failed (${response.status}): ${detail}`);
  }

  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  const token = body.access_token?.trim();
  if (!token) throw new Error("Business Hub sign-in returned no access token.");

  // expires_in is seconds; fall back to the documented hour if it is absent.
  const lifetimeMs = (body.expires_in ?? 3600) * 1000;
  cached = { token, expiresAt: Date.now() + lifetimeMs - EXPIRY_MARGIN_MS };
  return token;
}

async function accessToken(forceRefresh = false): Promise<string> {
  const c = config();
  if (forceRefresh) cached = null;
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  pending ??= login(c).finally(() => {
    pending = null;
  });
  return pending;
}

// --- Transport ------------------------------------------------------------

function message(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError" ? "timed out" : error.message;
  }
  return String(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Page = {
  rows: Record<string, unknown>[];
  /** Total matching rows, when an exact count was asked for. */
  total: number | null;
  truncated: boolean;
};

type GetOptions = { count?: boolean; limit?: number; signal?: AbortSignal };

/**
 * One GET against `/rest/v1/<path>`, with both required headers, a refresh on
 * 401 and a short backoff on transient failures.
 */
async function get(path: string, params: URLSearchParams, options: GetOptions = {}): Promise<Page> {
  const c = config();
  const url = `${c.endpoint}/rest/v1/${path}?${params.toString()}`;

  // Set for the one retry that follows a 401, then consumed — a later
  // transient retry must not throw away a token that is perfectly good.
  let forceLogin = false;
  let refreshed = false;
  let lastError = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const token = await accessToken(forceLogin);
    forceLogin = false;
    // The silent-empty trap: never issue a request that could come back as a
    // plausible-looking `[]` because authentication quietly went missing.
    if (!token) throw new Error("Refusing to query the Business Hub without an access token.");

    const headers: Record<string, string> = {
      apikey: c.apiKey,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (options.count) {
      headers.Prefer = "count=exact";
      // PostgREST will not count inline; ask for a zero-length window and read
      // the total out of Content-Range.
      headers.Range = "0-0";
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = message(error);
      if (attempt < MAX_RETRIES) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new Error(`Could not reach the Business Hub: ${lastError}`);
    }

    if (response.status === 401 && !refreshed) {
      // The token aged out mid-conversation. Sign in again and retry once,
      // without spending one of the transient-failure attempts on it.
      refreshed = true;
      forceLogin = true;
      attempt--;
      continue;
    }

    if (response.ok || response.status === 206) {
      const total = options.count ? parseTotal(response.headers.get("content-range")) : null;
      const body = (await response.json().catch(() => [])) as unknown;
      const all = Array.isArray(body) ? (body as Record<string, unknown>[]) : [body as Record<string, unknown>];
      const cap = Math.min(options.limit ?? MAX_ROWS, MAX_ROWS);
      return { rows: all.slice(0, cap), total, truncated: all.length > cap };
    }

    const detail = (await response.text().catch(() => "")).slice(0, 300);

    if (response.status === 403) {
      throw new Error(
        "The Business Hub refused that (403). This account is read-only and some rows are hidden by " +
          "row-level security — ask William if something needs changing. Nothing to retry.",
      );
    }
    if (response.status === 404) {
      throw new Error(`No such table or column in the Business Hub: ${path}. Call crm_schema to check.`);
    }
    if (response.status === 400 || response.status === 416) {
      throw new Error(`The Business Hub rejected that query (${response.status}): ${detail}`);
    }
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      lastError = `${response.status}: ${detail}`;
      await sleep(400 * 2 ** attempt);
      continue;
    }
    throw new Error(`Business Hub query failed (${response.status}): ${detail}`);
  }

  throw new Error(`Business Hub query failed after retries: ${lastError}`);
}

/** Reads the total out of a `0-24/92` Content-Range; null when unknown. */
function parseTotal(contentRange: string | null): number | null {
  const total = contentRange?.split("/")[1];
  if (!total || total === "*") return null;
  const n = Number(total);
  return Number.isFinite(n) ? n : null;
}

// --- Query building -------------------------------------------------------

/** Filter keys that are PostgREST operators rather than columns. */
const LOGICAL_KEYS = new Set(["or", "and", "not.or", "not.and"]);

export type QuerySpec = {
  table: TableName;
  select?: string;
  /** column -> PostgREST predicate, e.g. `status` -> `eq.Booked`. */
  filters?: Record<string, string>;
  order?: string;
  limit?: number;
  offset?: number;
  count?: boolean;
  signal?: AbortSignal;
};

/**
 * Validate the parts a caller composes by hand. PostgREST answers an unknown
 * column with a terse 400; naming the valid columns instead lets the agent fix
 * its own query on the next turn rather than guessing again.
 */
function checkColumn(table: TableName, raw: string, what: string): void {
  const head = raw.split(".")[0]!.trim();
  if (!head || head.includes("(")) return;

  const known = columnsOf(table);
  if (known.includes(head)) return;
  // Filters and sorts may address an embedded resource instead of a local
  // column — `companies.name` on a query over meetings. Only the head is
  // checkable; the embedded table's own columns are the server's business.
  if (isTable(head)) return;

  throw new Error(
    `${what} "${head}" is neither a column of ${table} nor a table to embed. ` +
      `Columns: ${known.join(", ")}.`,
  );
}

export async function query(spec: QuerySpec): Promise<Page> {
  if (!isTable(spec.table)) {
    throw new Error(`Unknown Business Hub table "${spec.table}". Call crm_schema for the list.`);
  }

  const params = new URLSearchParams();
  if (spec.select) params.set("select", spec.select);

  for (const [key, value] of Object.entries(spec.filters ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    if (!LOGICAL_KEYS.has(key)) checkColumn(spec.table, key, "Filter column");
    params.set(key, value);
  }

  if (spec.order) {
    for (const clause of spec.order.split(",")) {
      checkColumn(spec.table, clause.trim(), "Sort column");
    }
    params.set("order", spec.order);
  }

  const limit = Math.min(Math.max(spec.limit ?? 25, 1), MAX_ROWS);
  // With Prefer: count=exact the Range header owns the window, so a limit would
  // only fight it; ask for the count alone and let the caller re-query for rows.
  if (!spec.count) {
    params.set("limit", String(limit));
    if (spec.offset) params.set("offset", String(spec.offset));
  }

  return get(spec.table, params, { count: spec.count, limit, signal: spec.signal });
}

/** Total rows matching `filters`, using the Content-Range header. */
export async function count(
  table: TableName,
  filters: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<number | null> {
  const page = await query({ table, select: "id", filters, count: true, signal });
  return page.total;
}

// --- Shaping --------------------------------------------------------------

/**
 * Drop null and empty values before the rows reach the model. Sparse CRM rows
 * are the norm here and the empty keys are pure context cost. Recurses into
 * embedded rows, which are just as sparse.
 */
export function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined || raw === "") continue;
    if (Array.isArray(raw) && raw.length === 0) continue;
    out[key] = compact(raw);
  }
  return out;
}

export function compactAll(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => compact(row) as Record<string, unknown>);
}

// --- Profiles -------------------------------------------------------------

export type Profile = { id: string; name: string; email: string };

/**
 * `assignees` columns hold uuid[] with no FK constraint behind them, so
 * PostgREST cannot embed the names. The table is 13 rows and changes rarely —
 * cache it and resolve ids locally rather than making the model stare at uuids.
 */
const PROFILE_TTL_MS = 10 * 60_000;
let profileCache: { at: number; list: Profile[] } | null = null;

export async function profiles(signal?: AbortSignal): Promise<Profile[]> {
  if (profileCache && Date.now() - profileCache.at < PROFILE_TTL_MS) return profileCache.list;
  const page = await query({ table: "profiles", select: "id,name,email", order: "name", limit: MAX_ROWS, signal });
  const list = page.rows.map((row) => ({
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    email: String(row.email ?? ""),
  }));
  profileCache = { at: Date.now(), list };
  return list;
}

/** Turn an `assignees` uuid[] into names, leaving unknown ids as-is. */
export async function assigneeNames(ids: unknown, signal?: AbortSignal): Promise<string[] | undefined> {
  if (!Array.isArray(ids) || ids.length === 0) return undefined;
  const list = await profiles(signal);
  const byId = new Map(list.map((p) => [p.id, p.name || p.email]));
  return ids.map((id) => byId.get(String(id)) ?? String(id));
}

/** Resolve a name, email or id to one profile; null when it matches nothing. */
export async function findProfile(term: string, signal?: AbortSignal): Promise<Profile | null> {
  const needle = term.trim().toLowerCase();
  if (!needle) return null;
  const list = await profiles(signal);
  return (
    list.find((p) => p.id.toLowerCase() === needle) ??
    list.find((p) => p.email.toLowerCase() === needle) ??
    list.find((p) => p.name.toLowerCase() === needle) ??
    list.find((p) => p.name.toLowerCase().includes(needle)) ??
    null
  );
}

/** Today in Uppsala, as the `YYYY-MM-DD` the date columns use. */
export function today(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
}

export function daysFromToday(days: number): string {
  const now = new Date();
  now.setDate(now.getDate() + days);
  return now.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
}

/** `*foo*`-style wildcard for `ilike`, with PostgREST's separators escaped. */
export function wildcard(term: string): string {
  return `*${term.trim().replace(/[*,()]/g, " ").trim()}*`;
}

export { TABLES, type TableName, isTable };
