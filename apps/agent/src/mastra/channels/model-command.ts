// `./model` — lets a named maintainer swap the OpenRouter model from chat.
//
// Handled here rather than as a Mattermost slash command because the adapter
// does not dispatch those yet (see the feature matrix in README.md), so the
// command is recognised as an ordinary message prefix instead.
import type { Message, Thread } from "chat";
import { DEFAULT_MODEL, getModel, resetModel, setModel } from "../settings/store";

// Mattermost's webapp swallows anything starting with "/" as a slash command,
// so an unregistered "/model" never reaches the bot at all. "/model" is still
// accepted here in case a real slash command is registered later, but "!model"
// is the one that actually arrives today.
const COMMANDS = ["!model", "/model", "./model", ".model"] as const;
const PRIMARY_COMMAND = "!model";

/** Usernames allowed to change the model. Comma-separated, without the @. */
function admins(): string[] {
  return (process.env.MODEL_ADMINS ?? "alexander.andersson")
    .split(",")
    .map((name) => name.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
}

type ModelList = { ids: Set<string>; at: number };
let modelCache: ModelList | null = null;

/**
 * OpenRouter's catalogue, cached for ten minutes. Used to reject typos at the
 * point of the command rather than letting every later message fail. Returns
 * null when the catalogue cannot be fetched, in which case we accept the id
 * rather than blocking a legitimate change on a network blip.
 */
async function knownModelIds(): Promise<Set<string> | null> {
  if (modelCache && Date.now() - modelCache.at < 600_000) return modelCache.ids;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: { id?: string }[] };
    const ids = new Set((body.data ?? []).map((m) => m.id).filter((id): id is string => !!id));
    if (!ids.size) return null;
    modelCache = { ids, at: Date.now() };
    return ids;
  } catch {
    return null;
  }
}

/** Accepts "vendor/model", "openrouter/vendor/model", or a @-wrapped paste. */
function normalise(input: string): { bare: string; full: string } {
  const bare = input.trim().replace(/^`|`$/g, "").replace(/^openrouter\//, "");
  return { bare, full: `openrouter/${bare}` };
}

/**
 * Returns true when the message was a `./model` command and has been dealt
 * with, so the caller should not pass it to the agent.
 */
export async function handleModelCommand(thread: Thread, message: Message): Promise<boolean> {
  const text = message.text?.trim() ?? "";
  // Tolerate a leading @mention, since that is how people talk to it in channels.
  const stripped = text.replace(/^@[\w.\-]+\s+/, "").trim();
  const lower = stripped.toLowerCase();
  // Longest first, so "./model" is not mistaken for ".model" with an argument.
  const matched = [...COMMANDS]
    .sort((a, b) => b.length - a.length)
    .find((c) => lower === c || lower.startsWith(`${c} `));
  if (!matched) return false;

  const argument = stripped.slice(matched.length).trim();
  const userName = (message.author?.userName ?? "").toLowerCase();

  if (!admins().includes(userName)) {
    await thread.post(
      `Only ${admins().map((a) => `@${a}`).join(", ")} can change the model.`,
    );
    return true;
  }

  if (!argument) {
    await thread.post(
      `Current model: \`${await getModel()}\`\n` +
        `Usage: \`${PRIMARY_COMMAND} <openrouter-id>\` — e.g. \`${PRIMARY_COMMAND} anthropic/claude-sonnet-5\`\n` +
        `\`${PRIMARY_COMMAND} reset\` restores the default.`,
    );
    return true;
  }

  if (argument.toLowerCase() === "reset") {
    const restored = await resetModel(userName);
    await thread.post(`Model reset to the default: \`${restored}\``);
    return true;
  }

  const { bare, full } = normalise(argument);
  if (!/^[\w.\-]+\/[\w.\-:]+$/.test(bare)) {
    await thread.post(
      `\`${bare}\` doesn't look like an OpenRouter id. They're \`vendor/model\`, e.g. \`google/gemini-3-flash\`.`,
    );
    return true;
  }

  const known = await knownModelIds();
  if (known && !known.has(bare)) {
    // A `:free` / `:nitro` style suffix is a routing variant of a real model.
    const base = bare.split(":")[0];
    if (!known.has(base)) {
      await thread.post(
        `OpenRouter doesn't list \`${bare}\`. Check the id at https://openrouter.ai/models — ` +
          "the model stays on `" + (await getModel()) + "`.",
      );
      return true;
    }
  }

  await setModel(full, userName);
  await thread.post(
    `Model changed to \`${full}\`${known ? "" : " (couldn't reach OpenRouter to verify the id)"}. ` +
      "It applies from the next message.",
  );
  return true;
}

export { DEFAULT_MODEL };
