// A throwaway shell the agent can use to actually compute things — parse data,
// check arithmetic, reshape text — rather than doing it in its head.
//
// All of the safety lives in deploy/uuais-sandbox on the host: rootless Podman,
// no network, no host filesystem, no environment, no capabilities, and a hard
// 30-second kill. This file only pipes a script in and reads the output back,
// so nothing here can widen what the sandbox is allowed to do.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";

const SANDBOX_BIN = process.env.UUAIS_SANDBOX_BIN ?? "/usr/local/bin/uuais-sandbox";

// Generous: the wrapper's own 30s kill is the real limit, this only covers the
// case where the wrapper itself hangs before exec.
const HARD_TIMEOUT_MS = 45_000;
const MAX_SCRIPT_BYTES = 32_000;

export function sandboxAvailable(): boolean {
  try {
    accessSync(SANDBOX_BIN, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Run a script in the sandbox. Shared with the self-authored custom tools. */
export function runSandboxScript(script: string): Promise<{ output: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    // No arguments, and an environment built from scratch rather than inherited,
    // so none of the agent's tokens reach the child. PATH is set explicitly: an
    // empty environment leaves the wrapper relying on the shell's compiled-in
    // fallback path, which does not reliably find podman.
    const child = spawn(SANDBOX_BIN, [], {
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      out += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, HARD_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output: out, exitCode: code ?? -1, timedOut });
    });

    child.stdin.on("error", () => {
      /* the sandbox exited before reading stdin; the close handler reports it */
    });
    child.stdin.end(script);
  });
}

export const runSandboxedShell = createTool({
  id: "run_sandboxed_shell",
  description:
    "Run a short shell script in an isolated throwaway container to compute or " +
    "check something. `sh` and Python 3 are available. There is NO network and " +
    "NO access to UUAIS systems, files, or credentials — it cannot read the CRM, " +
    "Mattermost, the calendar or anything on the Pi, and nothing written survives " +
    "the call. Use it for calculation, parsing and text munging on data you " +
    "already have; use the other tools to reach real systems.",
  inputSchema: z.object({
    script: z
      .string()
      .max(MAX_SCRIPT_BYTES)
      .describe("Shell script, run with `sh`. Use python3 -c or a heredoc for Python."),
    purpose: z
      .string()
      .optional()
      .describe("One line on what this is for, shown to anyone reading the logs."),
  }),
  outputSchema: z.object({
    output: z.string(),
    exit_code: z.number(),
    timed_out: z.boolean(),
  }),
  execute: async ({ script, purpose }) => {
    if (!sandboxAvailable()) {
      throw new Error(
        `No sandbox on this host (${SANDBOX_BIN} not found). It is installed on the Pi deployment only.`,
      );
    }
    if (!script.trim()) throw new Error("Empty script.");

    console.log(`[sandbox] running script${purpose ? `: ${purpose}` : ""} (${script.length} bytes)`);
    const result = await runSandboxScript(script);

    return {
      output:
        result.output.trim() ||
        (result.exitCode === 0 ? "(no output)" : `(no output, exit code ${result.exitCode})`),
      exit_code: result.exitCode,
      timed_out: result.timedOut || result.exitCode === 124,
    };
  },
});

export const sandboxTools = { run_sandboxed_shell: runSandboxedShell };
