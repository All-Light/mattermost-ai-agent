import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { CrmReminderStore, type Assignment } from "./store";
import { deliverAssignments, isSundayReminderTime, renderAssignment, renderAssignments } from "./service";
import { handleCrmReminderCommand } from "./commands";
import type { Message, Thread } from "chat";

const assignment: Assignment = {
  taskId: "t1",
  profileId: "crm-profile-uuid",
  email: "person@uuais.com",
  name: "Person Name",
  title: "Write report",
  description: "Draft it",
  dueDate: "2026-10-02",
};
const clients: ReturnType<typeof createClient>[] = [];
function db() {
  const c = createClient({
    url: `file:/tmp/crm-reminder-test-${crypto.randomUUID()}.db`,
  });
  clients.push(c);
  return c;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe("CRM reminder persistence", () => {
  test("first complete snapshot seeds quietly; title edits stay quiet, re-additions notify", async () => {
    const store = new CrmReminderStore(db());
    expect(await store.reconcile([assignment])).toEqual([]);
    expect(await store.reconcile([assignment])).toEqual([]);
    expect(
      await store.reconcile([{ ...assignment, title: "Updated title" }]),
    ).toEqual([]);
    expect(await store.reconcile([])).toEqual([]);
    expect(await store.reconcile([assignment])).toHaveLength(1);
  });
  test("undelivered events survive restart and recipient context is isolated", async () => {
    const url = `file:/tmp/crm-reminder-test-${crypto.randomUUID()}.db`;
    const first = createClient({ url });
    clients.push(first);
    const store = new CrmReminderStore(first);
    await store.reconcile([]);
    await store.reconcile([assignment]);
    const second = createClient({ url });
    clients.push(second);
    const restarted = new CrmReminderStore(second);
    expect(await restarted.reconcile([assignment])).toHaveLength(1); // failed send retries
    await restarted.savePost("p1", "c1", "u1", "t1", "exact reminder");
    expect(await restarted.context("c1", "p1", "u1")).toContain(
      "exact reminder",
    );
    expect(await restarted.context("c1", "p1", "u2")).toBeNull();
    await restarted.markDelivered("t1", assignment.profileId);
    expect(await restarted.reconcile([assignment])).toEqual([]);
  });
  test("preferences default assignment on and weekly off", async () => {
    const store = new CrmReminderStore(db());
    expect(await store.preference("u1")).toEqual({
      enabled: true,
      weekly: false,
    });
    await store.setPreference("u1", { enabled: false, weekly: true });
    expect(await store.preference("u1")).toEqual({
      enabled: false,
      weekly: true,
    });
  });
  test("Sunday 18:00 follows Stockholm daylight saving time", () => {
    expect(isSundayReminderTime(new Date("2026-01-04T17:00:00Z"))).toBe(true);
    expect(isSundayReminderTime(new Date("2026-07-05T16:00:00Z"))).toBe(true);
    expect(isSundayReminderTime(new Date("2026-07-05T17:00:00Z"))).toBe(false);
  });
  test("opt-out keyed by Mattermost ID suppresses CRM-profile delivery and reply context stays recipient scoped", async () => {
    const store = new CrmReminderStore(db());
    const posts: string[] = [];
    const thread = {
      post: async (s: string) => {
        posts.push(s);
      },
    } as unknown as Thread;
    const command = {
      text: "!reminders off",
      author: { userId: "mattermost-user-id", isBot: false },
    } as Message;
    await handleCrmReminderCommand(thread, command, store);
    await store.reconcile([]);
    const pending = await store.reconcile([assignment]);
    let sent = 0;
    const deliver = (await import("./service")).deliverAssignments;
    await deliver(
      pending,
      store,
      async () => ({
        id: "mattermost-user-id",
        username: "person",
        email: assignment.email,
        first_name: "Person",
        last_name: "Name",
        delete_at: 0,
      }),
      async () => {
        sent++;
        return { postId: "p1", channelId: "c1", threadId: "dm-thread" };
      },
    );
    expect(sent).toBe(0);
    expect(posts[0]).toContain("off");
    expect(await store.preference("mattermost-user-id")).toEqual({
      enabled: false,
      weekly: false,
    });

    await store.setPreference("mattermost-user-id", {
      enabled: true,
      weekly: false,
    });
    const nextTask = { ...assignment, taskId: "t2", title: "Second task" };
    await deliver(
      await store.reconcile([assignment, nextTask]),
      store,
      async () => ({
        id: "mattermost-user-id",
        username: "person",
        email: assignment.email,
        first_name: "Person",
        last_name: "Name",
        delete_at: 0,
      }),
      async () => {
        sent++;
        return { postId: "p2", channelId: "c1", threadId: "dm-thread" };
      },
    );
    expect(sent).toBe(1);
    expect(await store.context("c1", "p2", "mattermost-user-id")).toContain(
      "Second task",
    );
    expect(await store.context("c1", "p2", "someone-else")).toBeNull();
  });
});

test("weekly is opt-in, survives restart and does not prevent other recipients after failure", async () => {
  const store = new CrmReminderStore(db());
  const { sendWeekly } = await import("./service");
  const tasks = [
    assignment,
    {
      ...assignment,
      profileId: "other-crm",
      email: "other@uuais.com",
      taskId: "t2",
    },
  ];
  const resolve = async (p: { email: string; name: string }) => ({
    id: p.email,
    username: p.name,
    email: p.email,
    first_name: "",
    last_name: "",
    delete_at: 0,
  });
  let calls = 0;
  const send = async (id: string) => {
    calls++;
    if (id === assignment.email) throw new Error("test failure");
    return {
      postId: "weekly-post",
      channelId: "weekly-channel",
      threadId: "weekly-thread",
    };
  };
  const sunday = new Date("2026-07-05T16:15:00Z");
  await sendWeekly(tasks, sunday, store, resolve, send);
  expect(calls).toBe(0);
  await store.setPreference(assignment.email, { enabled: true, weekly: true });
  await store.setPreference("other@uuais.com", { enabled: true, weekly: true });
  await sendWeekly(tasks, sunday, store, resolve, send);
  expect(calls).toBe(2);
  await store.setPreference(assignment.email, {
    enabled: false,
    weekly: false,
  });
  await sendWeekly(tasks, sunday, store, resolve, send);
  expect(calls).toBe(2);
});

test("assignment alerts batch by Mattermost recipient and preserve full context", async () => {
  const store = new CrmReminderStore(db());
  await store.reconcile([]);
  const tasks = [assignment, { ...assignment, taskId: "t2", title: "Second" }, { ...assignment, taskId: "t3", title: "Third" }, { ...assignment, taskId: "t4", profileId: "other", email: "other@uuais.com", title: "Other recipient" }];
  const pending = await store.reconcile(tasks);
  let sends = 0;
  const resolve = async (p: { email: string }) => ({ id: p.email.includes("other") ? "u2" : "u1", username: "", email: p.email, first_name: "", last_name: "", delete_at: 0 });
  const send = async (id: string, text: string) => {
    sends++;
    if (id === "u1") {
      expect(text).toContain("Second");
      expect(text).toContain("Third");
      return { postId: "batch-post", channelId: "dm", threadId: "thread" };
    }
    expect(id).toBe("u2");
    expect(text).toContain("Other recipient");
    return { postId: "other-post", channelId: "dm", threadId: "thread" };
  };
  await deliverAssignments(pending, store, resolve, send);
  expect(sends).toBe(2);
  expect(await store.context("dm", "batch-post", "u1")).toContain("Third");
  expect(await store.context("dm", "batch-post", "u2")).toBeNull();
  expect(await store.context("dm", "other-post", "u2")).toContain("Other recipient");
  expect(await store.reconcile(tasks)).toEqual([]);
});

test("same Mattermost recipient across CRM profiles is one batch; failure retries intact", async () => {
  const store = new CrmReminderStore(db());
  await store.reconcile([]);
  const tasks = [assignment, { ...assignment, taskId: "t2", profileId: "second-profile", email: "other@uuais.com", title: "Other profile" }];
  const pending = await store.reconcile(tasks);
  let resolveCalls = 0, sends = 0;
  const resolve = async (p: { email: string }) => { resolveCalls++; return { id: "same-mm-user", username: "", email: p.email, first_name: "", last_name: "", delete_at: 0 }; };
  await deliverAssignments(pending, store, resolve, async () => { sends++; throw new Error("offline"); });
  expect(resolveCalls).toBe(2);
  expect(sends).toBe(1);
  expect(await store.reconcile(tasks)).toHaveLength(2);
  await deliverAssignments(await store.reconcile(tasks), store, resolve, async () => ({ postId: "retry", channelId: "dm", threadId: "thread" }));
  expect(await store.context("dm", "retry", "same-mm-user")).toContain("Other profile");
});

test("batch renderer preserves one-task text and caps visible entries", () => {
  expect(renderAssignments([assignment])).toBe(renderAssignment(assignment));
  const many = Array.from({ length: 17 }, (_, i) => ({ ...assignment, taskId: `t${i}`, title: `Task ${i}` }));
  const message = renderAssignments(many);
  expect(message).toContain("17 new CRM tasks");
  expect(message).toContain("2 more");
  expect(message.match(/• Task/g)).toHaveLength(15);
});

test("opt-out suppresses all batch tasks and another recipient still receives its batch", async () => {
  const store = new CrmReminderStore(db());
  await store.reconcile([]);
  const tasks = [assignment, { ...assignment, taskId: "t2", title: "Second" }, { ...assignment, taskId: "t3", profileId: "p2", email: "other@uuais.com", title: "Other member" }];
  const pending = await store.reconcile(tasks);
  await store.setPreference("u1", { enabled: false, weekly: false });
  let sends = 0;
  const resolve = async (p: { email: string }) => ({ id: p.email.includes("other") ? "u2" : "u1", username: "", email: p.email, first_name: "", last_name: "", delete_at: 0 });
  await deliverAssignments(pending, store, resolve, async (id) => {
    sends++;
    expect(id).toBe("u2");
    return { postId: "u2-post", channelId: "dm", threadId: "thread" };
  });
  expect(sends).toBe(1);
  expect(await store.reconcile(tasks)).toEqual([]);
  expect(await store.context("dm", "u2-post", "u2")).toContain("Other member");
});
