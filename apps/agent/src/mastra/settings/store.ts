// Runtime-adjustable agent settings, kept in the same LibSQL database as memory
// and reminders so a change made in chat survives a restart or a redeploy.
//
// Values are cached in memory because the model is read on every single request;
// the database is only touched at startup and when someone changes something.
import { createClient, type Client } from "@libsql/client";

/** Used until someone overrides it in chat. */
export const DEFAULT_MODEL = process.env.AGENT_MODEL ?? "openrouter/z-ai/glm-5.3-flash";

type Settings = { model: string };

let client: Client | null = null;
let cache: Settings | null = null;
let ready: Promise<void> | null = null;

function db(): Client {
  if (!client) {
    client = createClient({ url: process.env.DATABASE_URL ?? "file:./mastra.db" });
  }
  return client;
}

async function load(): Promise<void> {
  await db().execute(`
    CREATE TABLE IF NOT EXISTS agent_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    )
  `);
  const result = await db().execute({
    sql: "SELECT value FROM agent_settings WHERE key = ?",
    args: ["model"],
  });
  const stored = result.rows[0]?.value;
  cache = { model: stored ? String(stored) : DEFAULT_MODEL };
  if (stored) console.log(`[settings] model override in effect: ${cache.model}`);
}

export function initSettings(): Promise<void> {
  if (!ready) {
    ready = load().catch((error) => {
      // A settings failure must not stop the bot answering; fall back to default.
      console.warn("[settings] could not load, using defaults:", error instanceof Error ? error.message : error);
      cache = { model: DEFAULT_MODEL };
    });
  }
  return ready;
}

export async function getModel(): Promise<string> {
  await initSettings();
  return cache?.model ?? DEFAULT_MODEL;
}

/** Read the cached value without touching the database. */
export function getModelSync(): string {
  return cache?.model ?? DEFAULT_MODEL;
}

export async function setModel(model: string, updatedBy: string): Promise<void> {
  await initSettings();
  await db().execute({
    sql: `INSERT INTO agent_settings (key, value, updated_at, updated_by) VALUES ('model', ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    args: [model, Date.now(), updatedBy],
  });
  cache = { ...(cache ?? { model: DEFAULT_MODEL }), model };
  console.log(`[settings] model changed to ${model} by ${updatedBy}`);
}

export async function resetModel(updatedBy: string): Promise<string> {
  await initSettings();
  await db().execute({ sql: "DELETE FROM agent_settings WHERE key = 'model'", args: [] });
  cache = { model: DEFAULT_MODEL };
  console.log(`[settings] model reset to default by ${updatedBy}`);
  return DEFAULT_MODEL;
}
