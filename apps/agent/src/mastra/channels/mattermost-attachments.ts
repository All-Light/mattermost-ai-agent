import type { Agent } from "@mastra/core/agent";
import type { ChannelHandler, ChannelHandlerContext } from "@mastra/core/channels";
import type { Message, Thread } from "chat";
import { checkRateLimit, RATE_LIMIT_LIMITS } from "./rate-limit";
import { handleModelCommand } from "./model-command";
import { handleHelpCommand } from "./help-command";
import { bindNewApprovals, handleApprovalCommand, pendingIds } from "./approval-command";
import { whileThinking } from "./thinking-reaction";
import { handleCrmReminderCommand } from "../crm-reminders/commands";
import { crmReminderStore } from "../crm-reminders/service";

// Adapter only sets `url` on attachments (bot-token auth needed); attach fetchData so Mastra inlines the bytes.
const enrichMattermostAttachments = (message: Message) => {
  const token = process.env.MATTERMOST_BOT_TOKEN;
  const baseUrl = process.env.MATTERMOST_BASE_URL?.replace(/\/$/, "");
  if (!token || !message.attachments?.length) return;

  for (const attachment of message.attachments) {
    if (attachment.fetchData || !attachment.url) continue;
    if (baseUrl && !attachment.url.startsWith(baseUrl)) continue;

    const url = attachment.url;
    attachment.fetchData = async () => {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error(
          `Mattermost file download failed: ${response.status} ${response.statusText}`,
        );
      }
      return Buffer.from(await response.arrayBuffer());
    };
  }
};

const chains = new Map<string, Promise<void>>();

async function handleMattermostMessage(
  thread: Thread,
  message: Message,
  defaultHandler: (thread: Thread, message: Message) => Promise<void>,
  ctx: ChannelHandlerContext,
  agent: Agent,
) {
  enrichMattermostAttachments(message);

  // Preference commands must always work, including when the sender exhausted the model rate limit.
  if (await handleCrmReminderCommand(thread, message, crmReminderStore)) return;

  // Per-user abuse guard (generous limits; bots/self excluded) so runaway loops can't burn model credits.
  const userId = message.author?.userId;
  const isBot = message.author?.isBot === true;
  if (userId && !isBot) {
    const reason = checkRateLimit(userId, {
      perMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? RATE_LIMIT_LIMITS.perMinute),
      perDay: Number(process.env.RATE_LIMIT_PER_DAY ?? RATE_LIMIT_LIMITS.perDay),
    });
    if (reason) {
      await thread.post(
        `You've hit the bot's ${reason}. Please wait a bit before messaging again — this keeps the bot free for everyone.`,
      );
      return;
    }
  }

  // A reminder reply inherits only this sender's reminder, and only in their DM.
  if (userId && !isBot && thread.isDM) {
    const raw = message.raw as { root_id?: string; parent_id?: string; post?: { root_id?: string; parent_id?: string } } | undefined;
    const rootPostId = raw?.post?.root_id || raw?.root_id || raw?.post?.parent_id || raw?.parent_id;
    try {
      const reminder = rootPostId
        ? await crmReminderStore.context(thread.channelId, rootPostId, userId)
        : await crmReminderStore.latestContext(thread.channelId, userId);
      if (reminder) ctx.requestContext.set("crmTaskReminderContext", reminder);
    } catch (error) { console.warn("[crm-reminders] Could not load reply context:", error instanceof Error ? error.message : error); }
  }

  // Commands are answered here and never reach the model, so they cost nothing
  // and behave identically whichever model is selected.
  if (await handleHelpCommand(thread, message)) return;
  if (await handleModelCommand(thread, message)) return;
  if (await handleApprovalCommand(thread, message, ctx, agent)) return;

  const before = await pendingIds(thread, ctx, agent);

  // Everything above answers instantly; only past this point does the member
  // wait on the model, so only past this point is a "working on it" marker
  // worth showing. 
  await whileThinking(thread, message, () => defaultHandler(thread, message));
  await bindNewApprovals(thread, message, ctx, agent, before);
}

/** Serializes one Mattermost conversation so the requester is bound to newly-created approvals. */
export function withMattermostAttachmentAuth(agent: Agent): ChannelHandler {
  return async (thread, message, defaultHandler, ctx) => {
    const previous = chains.get(thread.id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => handleMattermostMessage(thread, message, defaultHandler, ctx, agent));
    chains.set(thread.id, current);
    try {
      await current;
    } finally {
      if (chains.get(thread.id) === current) chains.delete(thread.id);
    }
  };
}
