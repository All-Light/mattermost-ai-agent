import type { Message, Thread } from "chat";
import { CrmReminderStore, type Preference } from "./store";

export async function handleCrmReminderCommand(
  thread: Thread,
  message: Message,
  store: CrmReminderStore,
): Promise<boolean> {
  const raw = (message.text ?? "")
    .trim()
    .replace(/^@[\w.\-]+\s+/, "")
    .toLowerCase();
  if (!raw.startsWith("!reminders")) return false;
  const sender = message.author?.userId;
  // The adapter uses "unknown" for lightweight WebSocket author records.
  if (!sender || message.author?.isBot === true) return true;
  const [command, subject, action] = raw.split(/\s+/);
  if (command !== "!reminders") return false;
  let pref: Preference;
  try {
    pref = await store.preference(sender);
  } catch (error) {
    await thread.post(
      `Could not read reminder settings: ${error instanceof Error ? error.message : "storage error"}`,
    );
    return true;
  }
  if (subject === "off" && !action) {
    if (await update({ enabled: false, weekly: false }))
      await thread.post(
        "CRM task reminders are off. Turn them back on with `!reminders on`.",
      );
  } else if (subject === "on" && !action) {
    if (await update({ ...pref, enabled: true }))
      await thread.post(
        "CRM assignment reminders are on. Weekly reminders are `" +
          (pref.weekly ? "on" : "off") +
          "`.",
      );
  } else if (subject === "status" && !action) {
    await thread.post(
      `CRM assignment reminders: ${pref.enabled ? "on" : "off"}. Weekly: ${pref.weekly ? "on" : "off"}.\nUse \`!reminders on|off\` or \`!reminders weekly on|off\`.`,
    );
  } else if (
    subject === "weekly" &&
    (action === "on" || action === "off") &&
    !raw.split(/\s+/)[3]
  ) {
    if (
      await update({
        enabled: action === "on" ? true : pref.enabled,
        weekly: action === "on",
      })
    )
      await thread.post(
        action === "on"
          ? "Weekly CRM reminders are on — Sundays at 18:00 Stockholm time. Assignment reminders are also on. Use `!reminders weekly off` to stop Sunday summaries."
          : "Weekly CRM reminders are off. Assignment reminders are unchanged.",
      );
  } else
    await thread.post(
      "Usage: `!reminders off`, `!reminders on`, `!reminders status`, `!reminders weekly on|off`.",
    );
  return true;
  async function update(next: Preference): Promise<boolean> {
    try {
      await store.setPreference(sender, next);
      return true;
    } catch (error) {
      await thread.post(
        `Could not save reminder settings: ${error instanceof Error ? error.message : "storage error"}`,
      );
      return false;
    }
  }
}
