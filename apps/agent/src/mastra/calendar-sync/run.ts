import { readFile } from "node:fs/promises";
import { createSyncEvent, listAllEvents, patchSyncEvent } from "../google/calendar";
import { crmSource } from "./crm-source";
import { plan } from "./planner";
import type { CalendarSource, ExistingLink } from "./source";

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Stockholm" }).format(new Date());
const sink = { list: listAllEvents, create: createSyncEvent, patch: patchSyncEvent };

export async function runSync(options: {
  sources: CalendarSource[];
  calendar?: typeof sink;
  links?: ExistingLink[];
  apply?: boolean;
  date?: string;
}) {
  const calendar = options.calendar ?? sink;
  // Finish all source reads before any writes. A source outage cannot masquerade as deletion.
  const snapshots = await Promise.all(options.sources.map(source => source.list()));
  const proposed = plan(snapshots.flatMap(s => s.records), await calendar.list(), options.date ?? today(),
    options.links, snapshots.flatMap(s => s.keys), options.sources.flatMap(s => s.namespaces));
  const issues = snapshots.flatMap(s => s.issues);
  console.log(JSON.stringify({ apply: !!options.apply,
    creates: proposed.create.map(e => ({ id: e.id, title: e.summary, start: e.start, end: e.end })),
    updates: proposed.update.map(({ old, next }) => ({ id: old.id, before: old.summary, after: next.summary, start: next.start, end: next.end })),
    unchanged: proposed.unchanged, conflicts: proposed.conflicts, missing: proposed.missing, issues,
  }));
  if (options.apply) {
    for (const event of proposed.create) await calendar.create(event);
    for (const { old, next } of proposed.update) await calendar.patch(old.id, next, old.etag!);
    console.log(`[calendar-sync] completed: ${proposed.create.length} created, ${proposed.update.length} updated, ${proposed.unchanged} unchanged`);
  }
  return { ...proposed, issues };
}

if (import.meta.main) {
  try {
    if (process.argv.slice(2).some(arg => !["--apply", "--dry-run"].includes(arg))) throw new Error("Usage: run.ts [--dry-run | --apply]");
    if (process.argv.includes("--apply") && process.argv.includes("--dry-run")) throw new Error("Choose --apply or --dry-run, not both");
    const path = process.env.CRM_CALENDAR_LINKS_FILE;
    const links: unknown = path ? JSON.parse(await readFile(path, "utf8")) : [];
    if (!Array.isArray(links) || !links.every(link => link && ["namespace", "id", "calendarEventId"].every(k => typeof link[k] === "string" && link[k].length))) throw new Error("Invalid calendar links file");
    const result = await runSync({ sources: [crmSource], links, apply: process.argv.includes("--apply") });
    if (result.conflicts.length || result.issues.length) process.exitCode = 2;
  } catch (error) {
    console.error("[calendar-sync] failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
