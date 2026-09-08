// Tools the agent writes for itself.
//
// The agent can save a shell/Python script under a name and description; that
// script then appears in its own tool list on the next turn and runs in the
// same sandbox as run_sandboxed_shell — no network, no host filesystem, no
// credentials, capped CPU and wall clock.
//
// The sandbox is the security boundary, not this file. Parameter values are
// interpolated into the script text with shell quoting, which matters for
// correctness rather than safety: code inside the sandbox is arbitrary by
// design, so a value that "escapes" into the script gains nothing it did not
// already have.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createClient, type Client } from "@libsql/client";
import { runSandboxScript, sandboxAvailable } from "./sandbox";

const NAME_PATTERN = /^[a-z][a-z0-9_]{2,40}$/;
const MAX_SCRIPT_BYTES = 16_000;
const MAX_TOOLS = 40;

export type CustomToolParam = { name: string; description: string; required: boolean };
export type CustomToolRecord = {
  name: string;
  description: string;
  script: string;
  params: CustomToolParam[];
  createdBy: string | null;
  updatedAt: number;
};

let client: Client | null = null;
let ready: Promise<void> | null = null;

function db(): Client {
  if (!client) client = createClient({ url: process.env.DATABASE_URL ?? "file:./mastra.db" });
  return client;
}

async function init(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await db().execute(`
        CREATE TABLE IF NOT EXISTS agent_custom_tools (
          name TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          script TEXT NOT NULL,
          params TEXT NOT NULL DEFAULT '[]',
          created_by TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    })();
  }
  return ready;
}

export async function listCustomTools(): Promise<CustomToolRecord[]> {
  await init();
  const result = await db().execute("SELECT * FROM agent_custom_tools ORDER BY name");
  return result.rows.map((r) => {
    const row = r as Record<string, unknown>;
    let params: CustomToolParam[] = [];
    try {
      params = JSON.parse(String(row.params ?? "[]"));
    } catch {
      params = [];
    }
    return {
      name: String(row.name),
      description: String(row.description),
      script: String(row.script),
      params,
      createdBy: row.created_by == null ? null : String(row.created_by),
      updatedAt: Number(row.updated_at),
    };
  });
}

export async function saveCustomTool(record: Omit<CustomToolRecord, "updatedAt">): Promise<void> {
  await init();
  const now = Date.now();
  await db().execute({
    sql: `INSERT INTO agent_custom_tools (name, description, script, params, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
            description = excluded.description,
            script = excluded.script,
            params = excluded.params,
            updated_at = excluded.updated_at`,
    args: [
      record.name,
      record.description,
      record.script,
      JSON.stringify(record.params),
      record.createdBy,
      now,
      now,
    ],
  });
}

export async function deleteCustomTool(name: string): Promise<boolean> {
  await init();
  const result = await db().execute({
    sql: "DELETE FROM agent_custom_tools WHERE name = ?",
    args: [name],
  });
  return result.rowsAffected > 0;
}

/** POSIX single-quote escaping: the only byte that needs care is the quote. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Build the script actually sent to the sandbox, with parameters bound. */
export function composeScript(record: CustomToolRecord, args: Record<string, unknown>): string {
  const preamble = record.params.map((p) => {
    const raw = args[p.name];
    const value = raw === undefined || raw === null ? "" : String(raw);
    return `PARAM_${p.name.toUpperCase()}=${shellQuote(value)}`;
  });
  preamble.push(`PARAMS_JSON=${shellQuote(JSON.stringify(args ?? {}))}`);
  return `${preamble.join("\n")}\n\n${record.script}`;
}

/**
 * The saved scripts, as tools the agent can call. Read fresh each time the
 * agent resolves its tool list, so a tool written this turn is usable the next.
 */
export async function buildCustomTools(): Promise<Record<string, ReturnType<typeof createTool>>> {
  if (!sandboxAvailable()) return {};

  let records: CustomToolRecord[] = [];
  try {
    records = await listCustomTools();
  } catch (error) {
    console.warn("[custom-tools] could not load:", error instanceof Error ? error.message : error);
    return {};
  }

  const tools: Record<string, ReturnType<typeof createTool>> = {};
  for (const record of records) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const p of record.params) {
      const field = z.string().describe(p.description);
      shape[p.name] = p.required ? field : field.optional();
    }

    tools[`custom_${record.name}`] = createTool({
      id: `custom_${record.name}`,
      description: `${record.description} (a script this agent wrote; runs in the isolated sandbox)`,
      inputSchema: z.object(shape),
      execute: async (input) => {
        const result = await runSandboxScript(
          composeScript(record, (input ?? {}) as Record<string, unknown>),
        );
        return {
          output: result.output.trim() || "(no output)",
          exit_code: result.exitCode,
          timed_out: result.timedOut,
        };
      },
    });
  }
  return tools;
}

// ----------------------------------------------------------- meta-tools

const paramSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,30}$/)
    .describe("Parameter name, lowercase; readable in the script as $PARAM_NAME (uppercased)"),
  description: z.string(),
  required: z.boolean().default(false),
});

export const createCustomTool = createTool({
  id: "create_custom_tool",
  description:
    "Save a script as a new tool you can call later. Use this when you find " +
    "yourself doing the same computation repeatedly. The script runs in the " +
    "sandbox: `sh` and Python 3, no network, no access to UUAIS systems. " +
    "Parameters arrive as shell variables $PARAM_<NAME> (uppercased) and as " +
    "$PARAMS_JSON. The script is test-run before saving and the output is " +
    "returned to you, so check it did what you meant. Overwrites a tool of the " +
    "same name.",
  inputSchema: z.object({
    name: z
      .string()
      .describe("lowercase_with_underscores, 3-41 chars; exposed as custom_<name>"),
    description: z
      .string()
      .describe("What it does and when to use it — this is what you will see later."),
    script: z.string().max(MAX_SCRIPT_BYTES).describe("Shell script; use python3 for real work."),
    parameters: z.array(paramSchema).optional().describe("Inputs the script accepts."),
  }),
  execute: async ({ name, description, script, parameters }) => {
    if (!sandboxAvailable()) throw new Error("No sandbox on this host, so custom tools cannot run.");
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`"${name}" must be lowercase letters, digits and underscores, 3-41 chars.`);
    }
    const existing = await listCustomTools();
    if (existing.length >= MAX_TOOLS && !existing.some((t) => t.name === name)) {
      throw new Error(`Too many custom tools (${MAX_TOOLS}). Delete one first.`);
    }

    const params = (parameters ?? []).map((p) => ({ ...p, required: p.required ?? false }));
    const record: CustomToolRecord = {
      name,
      description,
      script,
      params,
      createdBy: null,
      updatedAt: Date.now(),
    };

    // Smoke-test with empty parameters so an obviously broken script is caught
    // here rather than the next time it is needed.
    const trial = await runSandboxScript(composeScript(record, {}));

    await saveCustomTool(record);
    return {
      saved: `custom_${name}`,
      test_run: {
        exit_code: trial.exitCode,
        output: trial.output.trim().slice(0, 2000) || "(no output)",
        timed_out: trial.timedOut,
      },
      note: "Available as a tool from your next turn.",
    };
  },
});

export const listCustomToolsTool = createTool({
  id: "list_custom_tools",
  description: "List the tools you have written for yourself.",
  inputSchema: z.object({}),
  execute: async () => {
    const records = await listCustomTools();
    return records.map((r) => ({
      tool: `custom_${r.name}`,
      description: r.description,
      parameters: r.params.map((p) => `${p.name}${p.required ? "" : "?"}`),
      script_preview: r.script.split("\n").slice(0, 3).join("\n"),
    }));
  },
});

export const deleteCustomToolTool = createTool({
  id: "delete_custom_tool",
  description: "Delete a tool you wrote. Give the bare name, without the custom_ prefix.",
  inputSchema: z.object({ name: z.string() }),
  execute: async ({ name }) => {
    const bare = name.replace(/^custom_/, "");
    const deleted = await deleteCustomTool(bare);
    return deleted ? { deleted: `custom_${bare}` } : { deleted: null, reason: "No such custom tool." };
  },
});

export const customToolManagement = {
  create_custom_tool: createCustomTool,
  list_custom_tools: listCustomToolsTool,
  delete_custom_tool: deleteCustomToolTool,
};
