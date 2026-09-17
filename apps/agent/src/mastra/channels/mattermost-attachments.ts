import type { ChannelHandler } from "@mastra/core/channels";
import type { Message } from "chat";
import { checkRateLimit, RATE_LIMIT_LIMITS } from "./rate-limit";
import { handleModelCommand } from "./model-command";
import { handleHelpCommand } from "./help-command";
import { whileThinking } from "./thinking-reaction";

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

export const withMattermostAttachmentAuth: ChannelHandler = async (
  thread,
  message,
  defaultHandler,
) => {
  enrichMattermostAttachments(message);

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

  // Commands are answered here and never reach the model, so they cost nothing
  // and behave identically whichever model is selected.
  if (await handleHelpCommand(thread, message)) return;
  if (await handleModelCommand(thread, message)) return;

  // Everything above answers instantly; only past this point does the member
  // wait on the model, so only past this point is a "working on it" marker
  // worth showing. 
  await whileThinking(thread, message, () => defaultHandler(thread, message));
};
