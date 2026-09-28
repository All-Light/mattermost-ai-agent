import { expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import type { Message, Thread } from "chat";
import { handleCrmReminderCommand } from "./commands";
import { CrmReminderStore } from "./store";

for (const isBot of [false, "unknown"] as const) {
  test(`weekly command acknowledges and persists for isBot=${isBot}`, async () => {
    const client = createClient({ url: ":memory:" });
    try {
      const store = new CrmReminderStore(client);
      const replies: string[] = [];
      const thread = { post: async (text: string) => { replies.push(text); } } as unknown as Thread;
      const message = { text: "!reminders weekly on", author: { userId: "sender", isBot } } as Message;
      expect(await handleCrmReminderCommand(thread, message, store)).toBe(true);
      expect(await store.preference("sender")).toEqual({ enabled: true, weekly: true });
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("Weekly CRM reminders are on");
      expect(replies[0]).toContain("18:00 Stockholm");
      expect(await store.preference("someone-else")).toEqual({ enabled: true, weekly: false });
      await handleCrmReminderCommand(thread, { ...message, text: "!reminders weekly off" } as Message, store);
      expect(replies[1]).toContain("Weekly CRM reminders are off");
      expect(await store.preference("sender")).toEqual({ enabled: true, weekly: false });
    } finally { client.close(); }
  });
}
test("confirmed bot cannot enable reminder preferences", async () => {
  const client = createClient({ url: ":memory:" });
  try {
    const store = new CrmReminderStore(client);
    let replies = 0;
    const thread = { post: async () => { replies++; } } as unknown as Thread;
    await handleCrmReminderCommand(thread, { text: "!reminders weekly on", author: { userId: "bot", isBot: true } } as Message, store);
    expect(replies).toBe(0);
    expect(await store.preference("bot")).toEqual({ enabled: true, weekly: false });
  } finally { client.close(); }
});
