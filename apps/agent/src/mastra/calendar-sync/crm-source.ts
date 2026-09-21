import { query, type QuerySpec, type Page } from "../crm/client";
import { parseWhen, SOCIETY_TIMEZONE } from "../reminders/time";
import { sourceKey, type CalendarSource, type SourceRecord, type SourceSnapshot } from "./source";

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const dayAfter = (value: string) => new Date(Date.parse(value) + 86_400_000).toISOString().slice(0, 10);

function clock(value: string): string | null {
  const match = value.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  return `${String(hour % 12 + (match[3].toUpperCase() === "PM" ? 12 : 0)).padStart(2, "0")}:${match[2]}:00`;
}

/** Only explicit clock ranges are interpreted; a duration alone is not a start time. */
function explicitRange(date: string, value: string): { start: string; end: string } | null {
  const match = value.match(/^(\d{1,2}:\d{2}\s*(?:AM|PM))\s*[-–]\s*(\d{1,2}:\d{2}\s*(?:AM|PM))\s*(?:GMT([+-])(\d{1,2})(?::(\d{2}))?)?$/i);
  if (!match) return null;
  const start = clock(match[1]), end = clock(match[2]);
  if (!start || !end || end <= start) return null;
  if (match[3] && (Number(match[4]) > 14 || Number(match[5] ?? 0) > 59 || (Number(match[4]) === 14 && Number(match[5] ?? 0)))) return null;
  const zone = match[3] ? `${match[3]}${match[4].padStart(2, "0")}:${match[5] ?? "00"}` : "";
  return { start: new Date(parseWhen(`${date}T${start}${zone}`)).toISOString(), end: new Date(parseWhen(`${date}T${end}${zone}`)).toISOString() };
}

export function normalizeCrm(table: "events" | "meetings", rows: Record<string, unknown>[]): SourceSnapshot {
  const result: SourceSnapshot = { records: [], keys: [], issues: [] };
  for (const row of rows) {
    const namespace = `crm.${table}`, id = text(row.id), title = text(row.title);
    if (!id) throw new Error(`CRM ${table} returned a record without an id`);
    const key = sourceKey({ namespace, id });
    result.keys.push(key);
    const date = text(table === "events" ? row.date : row.meeting_date);
    if (!title || !validDate(date)) { result.issues.push(`${key}: missing title or invalid/missing date; skipped`); continue; }
    const record: SourceRecord = {
      namespace, id, title, status: table === "meetings" ? "Meeting" : text(row.status),
      start: { date }, end: { date: dayAfter(date) }, timing: "date-only",
      location: table === "events" ? text(row.venue) : "", details: "",
    };
    if (table === "events") {
      if (!["Planned", "Confirmed", "On hold", "Completed", "Cancelled"].includes(record.status)) {
        result.issues.push(`${key}: unrecognized status; skipped`); continue;
      }
      const duration = text(row.duration), range = explicitRange(date, duration);
      if (range) {
        record.start = { dateTime: range.start, timeZone: SOCIETY_TIMEZONE };
        record.end = { dateTime: range.end, timeZone: SOCIETY_TIMEZONE };
        record.timing = "exact";
      } else record.details = `Time TBD — CRM duration: ${duration || "not set"}.`;
      const link = text(row.luma_link);
      if (/^https:\/\//i.test(link)) record.details += `\nRegistration: ${link}`;
    } else {
      const time = text(row.meeting_time);
      if (/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) {
        const start = parseWhen(`${date}T${time}`);
        record.start = { dateTime: new Date(start).toISOString(), timeZone: SOCIETY_TIMEZONE };
        record.end = { dateTime: new Date(start + 3_600_000).toISOString(), timeZone: SOCIETY_TIMEZONE };
        record.timing = "estimated";
        record.details = "Duration estimated at 60 minutes; CRM supplies a start time but no end time.";
      } else record.details = "Time TBD — CRM has no usable meeting start time.";
    }
    result.records.push(record);
  }
  return result;
}

export async function readCrmPages(table: "events" | "meetings", select: string, read: (spec: QuerySpec) => Promise<Page> = query) {
  const rows: Record<string, unknown>[] = [], seen = new Set<string>();
  for (let offset = 0; offset < 100_000; offset += 200) {
    const page = await read({ table, select, order: "id.asc", limit: 200, offset });
    if (page.truncated || !Array.isArray(page.rows)) throw new Error(`CRM ${table} page was incomplete`);
    for (const row of page.rows) {
      const id = text(row?.id);
      if (!id || seen.has(id)) throw new Error(`CRM ${table} pagination returned missing/duplicate IDs`);
      seen.add(id); rows.push(row);
    }
    if (page.rows.length < 200) return rows;
  }
  throw new Error(`CRM ${table} pagination exceeded safety limit`);
}

export const crmSource: CalendarSource = {
  namespaces: ["crm.events", "crm.meetings"],
  async list() {
    const [events, meetings] = await Promise.all([
      readCrmPages("events", "id,title,status,date,duration,venue,luma_link"),
      readCrmPages("meetings", "id,title,meeting_date,meeting_time,internal"),
    ]);
    const snapshots = [normalizeCrm("events", events), normalizeCrm("meetings", meetings)];
    return { records: snapshots.flatMap(s => s.records), keys: snapshots.flatMap(s => s.keys), issues: snapshots.flatMap(s => s.issues) };
  },
};
