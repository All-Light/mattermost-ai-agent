// Read-only tools over the bot's own mailbox. There is deliberately no send
// tool: the transport is IMAP, which cannot send mail at all.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { inboxAddress, inboxConfigured, listMessages, readMessage, searchMessages } from "../google/inbox";

function requireInbox(): void {
  if (!inboxConfigured()) {
    throw new Error("The bot mailbox is not configured (GOOGLE_BOT_NAME / GOOGLE_BOT_PASSWORD).");
  }
}

export const listInbox = createTool({
  id: "list_inbox",
  description:
    "List recent messages in the bot's own mailbox (newest first) with sender, " +
    "subject and date. Read-only — the bot cannot send, delete or mark mail.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).optional().describe("Default 10"),
    unread_only: z.boolean().optional(),
    mailbox: z.string().optional().describe('Default "INBOX"'),
  }),
  execute: async ({ limit, unread_only, mailbox }) => {
    requireInbox();
    const messages = await listMessages({ limit, unreadOnly: unread_only, mailbox });
    return { mailbox: mailbox ?? "INBOX", account: inboxAddress(), count: messages.length, messages };
  },
});

export const readInboxMessage = createTool({
  id: "read_email",
  description:
    "Read one message in full from the bot's mailbox. Get the uid from " +
    "list_inbox or search_inbox first.",
  inputSchema: z.object({
    uid: z.number().int().describe("Message uid from list_inbox"),
    mailbox: z.string().optional(),
  }),
  execute: async ({ uid, mailbox }) => {
    requireInbox();
    return readMessage(uid, mailbox ?? "INBOX");
  },
});

export const searchInbox = createTool({
  id: "search_inbox",
  description: "Search the bot's mailbox by subject, sender or body text.",
  inputSchema: z.object({
    query: z.string(),
    limit: z.number().int().min(1).max(50).optional(),
    mailbox: z.string().optional(),
  }),
  execute: async ({ query, limit, mailbox }) => {
    requireInbox();
    const messages = await searchMessages(query, { limit, mailbox });
    return { query, count: messages.length, messages };
  },
});

export const inboxTools = {
  list_inbox: listInbox,
  read_email: readInboxMessage,
  search_inbox: searchInbox,
};
