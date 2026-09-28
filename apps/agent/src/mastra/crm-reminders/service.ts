import { query, crmConfigured, type Profile } from "../crm/client";
import {
  crmDirectMessage,
  mattermostConfigured,
  resolveCrmUser,
} from "../mattermost/rest";
import { CrmReminderStore, type Assignment } from "./store";

const CRM_URL = "https://uuaibiz.vercel.app";
const POLL_MS = 30 * 60_000;
let polling = false;
const store = new CrmReminderStore();

type CrmQuery = typeof query;

async function allRows(
  table: "tasks" | "profiles",
  select: string,
  signal: AbortSignal,
  fetchPage: CrmQuery,
  filters: Record<string, string> = {},
) {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (let offset = 0; ; offset += 200) {
    const page = await fetchPage({
      table,
      select,
      filters,
      order: "id",
      limit: 200,
      offset,
      signal,
    });
    if (page.truncated || page.rows.length > 200)
      throw new Error(`CRM ${table} page was truncated; preserving reminder baseline.`);
    for (const row of page.rows) {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id.trim() || seen.has(row.id))
        throw new Error(`CRM ${table} pagination returned malformed or repeated rows; preserving reminder baseline.`);
      seen.add(row.id);
    }
    rows.push(...page.rows);
    if (page.rows.length < 200) return rows;
    if (offset > 100_000)
      throw new Error(`CRM ${table} pagination exceeded safety limit.`);
  }
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Invalid CRM task ${field}.`);
  return value.trim();
}

export async function fetchAssignments(fetchPage: CrmQuery = query): Promise<{
  assignments: Assignment[];
  profiles: Profile[];
}> {
  const signal = AbortSignal.timeout(120_000);
  const tasks = await allRows(
    "tasks", "id,title,description,status,due_date,assignees", signal, fetchPage,
    { status: 'in.("To do","In progress")', assignees: "not.eq.{}" },
  );
  const ids = [...new Set(tasks.flatMap((row) => {
    if (!Array.isArray(row.assignees) || row.assignees.some((id) => typeof id !== "string"))
      throw new Error(`Invalid CRM assignees for task ${String(row.id)}; preserving reminder baseline.`);
    return row.assignees as string[];
  }))];
  const safeId = /^[A-Za-z0-9-]+$/;
  if (ids.some((id) => !safeId.test(id)))
    throw new Error("Invalid CRM profile ID in task assignees; preserving reminder baseline.");
  const profileRows: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    profileRows.push(...await allRows("profiles", "id,name,email", signal, fetchPage, {
      id: `in.(${batch.join(",")})`,
    }));
  }
  const profiles = profileRows.map((row) => ({
    id: string(row.id, "profile id"),
    name: typeof row.name === "string" ? row.name.trim() : "",
    email: typeof row.email === "string" ? row.email.trim() : "",
  }));
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const assignments: Assignment[] = [];
  for (const row of tasks) {
    const id = string(row.id, "id"),
      status = string(row.status, "status");
    if (!["To do", "In progress", "Done"].includes(status))
      throw new Error(
        `Unknown CRM task status "${status}"; preserving reminder baseline.`,
      );
    if (status === "Done") continue;
    if (row.assignees == null) row.assignees = [];
    if (
      !Array.isArray(row.assignees) ||
      row.assignees.some((id) => typeof id !== "string")
    )
      throw new Error(`Invalid CRM assignees for task ${id}.`);
    const title = string(row.title, "title");
    for (const rawId of new Set(row.assignees as string[])) {
      const person = byId.get(rawId);
      if (!person)
        throw new Error(
          `CRM task ${id} references unknown profile ${rawId}; preserving reminder baseline.`,
        );
      assignments.push({
        taskId: id,
        profileId: person.id,
        email: person.email,
        name: person.name,
        title,
        description:
          typeof row.description === "string" ? row.description.trim() : "",
        dueDate: typeof row.due_date === "string" ? row.due_date : "",
      });
    }
  }
  return { assignments, profiles };
}

export function renderAssignment(a: Assignment): string {
  const title = a.title.slice(0, 120);
  const details = [
    a.dueDate ? `Due ${a.dueDate}` : "",
    a.description.slice(0, 240),
  ]
    .filter(Boolean)
    .join(" · ");
  return `CRM task: **${title}**${details ? ` — ${details}` : ""}\nIf you want more info ask me or check the CRM at ${CRM_URL}.\nUse \`!reminders off\` to stop these DMs or \`!reminders weekly on\` for a Sunday summary.`;
}

export function renderAssignments(tasks: Assignment[]): string {
  const unique = [...new Map(tasks.map((task) => [task.taskId, task])).values()];
  if (unique.length === 1) return renderAssignment(unique[0]!);
  const cap = 15;
  const visible = unique.slice(0, cap);
  const lines = visible.map((task) => {
    const details = [task.dueDate ? `due ${task.dueDate}` : "", task.description.slice(0, 100)]
      .filter(Boolean).join(" · ");
    return `• ${task.title.slice(0, 100)}${details ? ` — ${details}` : ""}`;
  });
  const omitted = unique.length - visible.length;
  return `You have ${unique.length} new CRM tasks:\n${lines.join("\n")}${omitted ? `\n…and ${omitted} more.` : ""}\nIf you want more info ask me or check the CRM at ${CRM_URL}.\nUse \`!reminders off\` to stop these DMs or \`!reminders weekly on\` for a Sunday summary.`;
}

export async function pollCrmAssignments(now = new Date()): Promise<void> {
  if (polling || !crmConfigured() || !mattermostConfigured()) return;
  polling = true;
  try {
    const { assignments } = await fetchAssignments();
    const added = await store.reconcile(assignments);
    console.info(
      `[crm-reminders] poll complete: ${assignments.length} active assignments; ${added.length} pending alerts`,
    );
    await deliverAssignments(added, store, resolveCrmUser, crmDirectMessage);
    if (isSundayReminderTime(now)) await sendWeekly(assignments, now);
  } catch (error) {
    console.error(
      "[crm-reminders] CRM poll failed; keeping previous baseline:",
      error instanceof Error ? error.message : error,
    );
  } finally {
    polling = false;
  }
}

export async function deliverAssignments(
  assignments: Assignment[],
  state: CrmReminderStore,
  resolve: typeof resolveCrmUser = resolveCrmUser,
  send: typeof crmDirectMessage = crmDirectMessage,
) {
  const byProfile = new Map<string, Assignment[]>();
  for (const task of assignments) {
    byProfile.set(task.profileId, [...(byProfile.get(task.profileId) ?? []), task]);
  }
  const resolved = new Map<string, { tasks: Assignment[]; memberId: string }>();
  for (const [profileId, profileTasks] of byProfile) {
    const task = profileTasks[0]!;
    try {
      const member = await resolve({ email: task.email, name: task.name });
      resolved.set(profileId, { tasks: profileTasks, memberId: member.id });
    } catch (error) {
      console.error(`[crm-reminders] DM resolution failed for task ${task.taskId}:`, error instanceof Error ? error.message : error);
    }
  }
  const recipients = new Map<string, Assignment[]>();
  for (const entry of resolved.values())
    recipients.set(entry.memberId, [...(recipients.get(entry.memberId) ?? []), ...entry.tasks]);
  for (const [memberId, recipientTasks] of recipients) {
    const tasks = [...new Map(recipientTasks.map((task) => [task.taskId, task])).values()];
    const pairs = [...new Map(recipientTasks.map((task) => [`${task.taskId}:${task.profileId}`, { taskId: task.taskId, profileId: task.profileId }])).values()];
    try {
      const pref = await state.preference(memberId);
      if (!pref.enabled) {
        await state.completeAssignmentBatch(null, pairs);
        continue;
      }
      const text = renderAssignments(tasks);
      const sent = await send(memberId, text);
      await state.completeAssignmentBatch({ postId: sent.postId, channelId: sent.channelId, userId: memberId, taskIds: tasks.map((task) => task.taskId), message: text }, pairs);
    } catch (error) {
      console.error(
        `[crm-reminders] DM failed for recipient ${memberId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

export function isSundayReminderTime(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Stockholm",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return p.weekday === "Sun" && p.hour === "18";
}
function stockholmWeek(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
export async function sendWeekly(
  assignments: Assignment[],
  now: Date,
  state = store,
  resolve: typeof resolveCrmUser = resolveCrmUser,
  send: typeof crmDirectMessage = crmDirectMessage,
) {
  const byProfile = new Map<string, Assignment[]>();
  for (const task of assignments)
    byProfile.set(task.profileId, [
      ...(byProfile.get(task.profileId) ?? []),
      task,
    ]);
  const week = stockholmWeek(now);
  for (const tasks of byProfile.values()) {
    try {
      const profile = tasks[0]!;
      const member = await resolve({
        email: profile.email,
        name: profile.name,
      });
      const pref = await state.preference(member.id);
      if (
        !pref.enabled ||
        !pref.weekly ||
        (await state.wasWeeklySent(member.id, week))
      )
        continue;
      const cap = 15,
        visible = tasks.slice(0, cap),
        omitted = tasks.length - visible.length;
      const message = `Your open CRM tasks (${tasks.length}):\n${visible.map((t) => `• ${t.title.slice(0, 100)}${t.dueDate ? ` (due ${t.dueDate})` : ""}`).join("\n")}${omitted ? `\n…and ${omitted} more.` : ""}\nIf you want more info ask me or check the CRM at ${CRM_URL}.\nUse \`!reminders off\` to stop DMs or \`!reminders weekly off\` to stop Sunday summaries.`;
      const sent = await send(member.id, message);
      await state.savePost(
        sent.postId,
        sent.channelId,
        member.id,
        "weekly",
        message,
      );
      await state.markWeeklySent(member.id, week);
    } catch (error) {
      console.error(
        "[crm-reminders] Weekly DM failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}
export function startCrmReminderPoller() {
  if (["false", "0"].includes(process.env.CRM_REMINDERS_ENABLED ?? "")) return;
  console.info(
    "[crm-reminders] polling every 30 minutes; weekly summaries Sunday 18:00 Europe/Stockholm",
  );
  void pollCrmAssignments();
  setInterval(() => void pollCrmAssignments(), POLL_MS).unref?.();
}
export { store as crmReminderStore };
