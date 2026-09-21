import { createHash } from "node:crypto";
import type { CalendarEvent, SyncEventInput } from "../google/calendar";
import { parseWhen, SOCIETY_TIMEZONE } from "../reminders/time";
import { sourceKey, type SourceRecord, type ExistingLink } from "./source";

export const OWNER = "uuais-calendar-sync";
const BEGIN = "--- UUAIS calendar sync ---", END = "--- End calendar sync ---";
export const eventId = (record: Pick<SourceRecord, "namespace" | "id">) => createHash("sha256").update(sourceKey(record)).digest("hex");
const localDate = (time?: CalendarEvent["start"]) => time?.date ?? (time?.dateTime
  ? new Intl.DateTimeFormat("en-CA", { timeZone: SOCIETY_TIMEZONE }).format(new Date(parseWhen(time.dateTime))) : "");
const instant = (time?: CalendarEvent["start"]) => time?.date ? `date:${time.date}` : time?.dateTime ? `instant:${parseWhen(time.dateTime)}` : "";
const titleKey = (title = "") => title.replace(/^\[(?:Planned|Confirmed|On hold|Completed|Cancelled|Meeting)\]\s*/i, "").replace(/\s*\[Time TBD\]$/i, "").trim().toLowerCase();

function managedDescription(old: string | undefined, details: string): string {
  const start = old?.indexOf(BEGIN) ?? -1, end = old?.indexOf(END, Math.max(start, 0)) ?? -1;
  const human = start >= 0 && end >= start ? `${old!.slice(0, start)}${old!.slice(end + END.length)}`.trim() : (old ?? "").trim();
  return [human, `${BEGIN}\n${details}\n${END}`].filter(Boolean).join("\n\n");
}

function desired(record: SourceRecord, old?: CalendarEvent): SyncEventInput {
  let start = record.start, end = record.end, details = record.details, inherited = false;
  if (record.timing === "date-only" && old?.start?.dateTime && old.end?.dateTime) {
    // Preserve calendar-supplied times when the source only knows a date, moving
    // the same local clock time when that date changes (including across DST).
    const time = new Intl.DateTimeFormat("sv-SE", { timeZone: SOCIETY_TIMEZONE, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(parseWhen(old.start.dateTime)));
    const from = parseWhen(`${record.start.date}T${time}`);
    const duration = parseWhen(old.end.dateTime) - parseWhen(old.start.dateTime);
    if (duration > 0) {
      start = { dateTime: new Date(from).toISOString(), timeZone: SOCIETY_TIMEZONE };
      end = { dateTime: new Date(from + duration).toISOString(), timeZone: SOCIETY_TIMEZONE };
      inherited = true;
      details = `${details}\nCalendar-supplied time retained; the source has no explicit time range.`;
    }
  }
  const placeholder = record.timing === "date-only" && !inherited;
  return {
    id: old?.id ?? eventId(record),
    summary: `[${record.status}] ${record.title}${placeholder ? " [Time TBD]" : ""}`,
    description: managedDescription(old?.description, `Source: ${record.namespace}\nRecord ID: ${record.id}\nStatus: ${record.status}\n${details}`.trim()),
    location: record.location,
    start, end,
    transparency: ["Planned", "On hold", "Cancelled"].includes(record.status) || placeholder ? "transparent" : "opaque",
    private: { ...old?.extendedProperties?.private, createdBy: OWNER, syncOwner: OWNER, source: record.namespace, sourceId: record.id },
  };
}

function unchanged(old: CalendarEvent, next: SyncEventInput): boolean {
  return old.summary === next.summary && (old.description ?? "") === next.description
    && (old.location ?? "") === (next.location ?? "")
    && instant(old.start) === instant(next.start) && instant(old.end) === instant(next.end)
    && (old.transparency ?? "opaque") === next.transparency
    && Object.entries(next.private).every(([key, value]) => old.extendedProperties?.private?.[key] === value);
}

export type Plan = {
  create: SyncEventInput[];
  update: Array<{ old: CalendarEvent; next: SyncEventInput }>;
  conflicts: string[];
  missing: string[];
  unchanged: number;
};

export function plan(records: SourceRecord[], existing: CalendarEvent[], today: string, links: ExistingLink[] = [], keys = records.map(sourceKey), namespaces = [...new Set(records.map(r => r.namespace))]): Plan {
  const result: Plan = { create: [], update: [], conflicts: [], missing: [], unchanged: 0 };
  const byId = new Map(existing.map(e => [e.id, e]));
  const owned = new Map<string, CalendarEvent>();
  for (const event of existing) {
    const p = event.extendedProperties?.private;
    if (p?.syncOwner !== OWNER || !p.source || !p.sourceId) continue;
    const key = `${p.source}:${p.sourceId}`;
    if (owned.has(key)) throw new Error(`Duplicate calendar source identity: ${key}`);
    owned.set(key, event);
    if (namespaces.includes(p.source) && !keys.includes(key)) result.missing.push(`${key}: missing from source; calendar retained`);
  }
  const linked = new Map<string, string>(), targetIds = new Set<string>();
  for (const link of links) {
    const key = sourceKey(link);
    if (linked.has(key) || targetIds.has(link.calendarEventId)) throw new Error("Duplicate explicit calendar link");
    linked.set(key, link.calendarEventId); targetIds.add(link.calendarEventId);
  }
  const seen = new Set<string>();
  for (const record of records) {
    const key = sourceKey(record);
    if (seen.has(key)) throw new Error(`Duplicate source record: ${key}`);
    seen.add(key);
    const linkedId = linked.get(key);
    const old = owned.get(key) ?? (linkedId ? byId.get(linkedId) : undefined);
    if (linkedId && !old) { result.conflicts.push(`${key}: explicitly linked event ${linkedId} not found`); continue; }
    const props = old?.extendedProperties?.private;
    if (old && props?.syncOwner && (props.syncOwner !== OWNER || props.source !== record.namespace || props.sourceId !== record.id)) {
      result.conflicts.push(`${key}: linked event belongs to another source`); continue;
    }
    if (old?.recurrence?.length) { result.conflicts.push(`${key}: recurring event cannot be adopted`); continue; }
    const next = desired(record, old);
    if (old) {
      if (unchanged(old, next)) result.unchanged++;
      else if (!old.etag) result.conflicts.push(`${key}: existing event has no concurrency token`);
      else result.update.push({ old, next });
    } else if (localDate(record.start) >= today) {
      const collision = byId.get(next.id) ?? existing.find(e => titleKey(e.summary) === titleKey(record.title) && localDate(e.start) === localDate(record.start));
      if (collision) result.conflicts.push(`${key}: possible existing event ${collision.id}; link explicitly before syncing`);
      else result.create.push(next);
    }
  }
  return result;
}
