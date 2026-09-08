// Tools that let the agent reach a member directly in Mattermost, rather than
// only replying where it was spoken to.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { directMessage, mattermostConfigured } from "../mattermost/rest";
import { cancelReminder, createReminder, listReminders } from "../reminders/store";
import { formatWhen, parseWhen, SOCIETY_TIMEZONE } from "../reminders/time";

const recipient = z
  .string()
  .describe(
    "Who to reach: a Mattermost @username, a bare username, or an email address. " +
      "Email is the reliable key when the person came from the Business Hub.",
  );

function requireMattermost(): void {
  if (!mattermostConfigured()) {
    throw new Error("Mattermost is not configured (MATTERMOST_BASE_URL / MATTERMOST_BOT_TOKEN).");
  }
}

export const remindMember = createTool({
  id: "remind_member",
  description:
    "Schedule a reminder to be sent to a member as a Mattermost direct message " +
    `at a future time. Times without a timezone are read as ${SOCIETY_TIMEZONE} ` +
    "(Uppsala) local. Use it for deadlines, task due dates and event prep — " +
    "prefer it over messaging someone immediately. For a person who appears in " +
    "the Business Hub, pass their email address: the CRM and Mattermost share " +
    "the email but their usernames differ. Read the scheduled time back to the " +
    "requester so a mistake is caught before it fires.",
  inputSchema: z.object({
    recipient,
    message: z.string().describe("What the reminder should say, in the member's own language."),
    when: z
      .string()
      .optional()
      .describe('ISO-8601 time, e.g. "2026-09-08T09:00". Date only means 09:00 that day.'),
    in_minutes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Alternative to `when`: fire this many minutes from now."),
  }),
  outputSchema: z.object({
    id: z.string(),
    recipient: z.string(),
    scheduled_for: z.string(),
  }),
  execute: async ({ recipient: ref, message, when, in_minutes }) => {
    requireMattermost();
    if (!when && !in_minutes) {
      throw new Error("Pass either `when` (ISO-8601) or `in_minutes`.");
    }

    const dueAt = in_minutes ? Date.now() + in_minutes * 60_000 : parseWhen(when!);
    if (dueAt <= Date.now()) {
      throw new Error(
        `That time (${formatWhen(dueAt)}) is in the past. Use message_member to send something now.`,
      );
    }

    // Fail early on an unknown recipient rather than at delivery time, when
    // nobody is around to correct the name.
    const { resolveUser } = await import("../mattermost/rest");
    const user = await resolveUser(ref);

    const reminder = await createReminder({ recipientRef: ref, message, dueAt });
    return {
      id: reminder.id,
      recipient: `@${user.username}`,
      scheduled_for: formatWhen(dueAt),
    };
  },
});

export const messageMember = createTool({
  id: "message_member",
  description:
    "Send a Mattermost direct message to a member right now. Use sparingly — this " +
    "reaches someone outside the current conversation. For anything in the future, " +
    "use remind_member instead.",
  // Messaging a third party on someone's behalf is the one action here with a
  // real blast radius, so a human confirms each one.
  requireApproval: true,
  inputSchema: z.object({
    recipient,
    message: z.string().describe("The message to send. Written as the bot, not as the requester."),
  }),
  outputSchema: z.object({
    recipient: z.string(),
    post_id: z.string(),
  }),
  execute: async ({ recipient: ref, message }) => {
    requireMattermost();
    const sent = await directMessage(ref, message);
    return { recipient: `@${sent.username}`, post_id: sent.postId };
  },
});

export const listRemindersTool = createTool({
  id: "list_reminders",
  description: "List reminders the bot has scheduled, soonest first.",
  inputSchema: z.object({
    status: z.enum(["pending", "sent", "failed", "cancelled"]).optional(),
    recipient: z.string().optional().describe("Filter to reminders aimed at this member"),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  execute: async ({ status, recipient: ref, limit }) => {
    const rows = await listReminders({ status, recipientRef: ref, limit });
    return rows.map((r) => ({
      id: r.id,
      recipient: r.recipientRef,
      message: r.message,
      due: formatWhen(r.dueAt),
      status: r.status,
      ...(r.lastError ? { last_error: r.lastError } : {}),
    }));
  },
});

export const cancelReminderTool = createTool({
  id: "cancel_reminder",
  description: "Cancel a pending reminder by its id (get ids from list_reminders).",
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }) => {
    const cancelled = await cancelReminder(id);
    return cancelled
      ? { cancelled: true, id }
      : { cancelled: false, id, reason: "No pending reminder with that id." };
  },
});

export const reminderTools = {
  remind_member: remindMember,
  message_member: messageMember,
  list_reminders: listRemindersTool,
  cancel_reminder: cancelReminderTool,
};
