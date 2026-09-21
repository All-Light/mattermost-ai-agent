import { describe, expect, mock, test } from "bun:test";
import { normalizeCrm, readCrmPages } from "./crm-source";
import { eventId, OWNER, plan } from "./planner";
import { runSync } from "./run";
import type { CalendarEvent, SyncEventInput } from "../google/calendar";
import type { CalendarSource, SourceRecord } from "./source";

const record = (changes: Partial<SourceRecord> = {}): SourceRecord => ({ namespace: "crm.events", id: "stable-id", title: "Original name", status: "Planned", start: { date: "2026-10-10" }, end: { date: "2026-10-11" }, timing: "date-only", location: "Room A", details: "Time TBD", ...changes });
const google = (event: SyncEventInput): CalendarEvent => ({ id: event.id, summary: event.summary, description: event.description, location: event.location, start: event.start, end: event.end, transparency: event.transparency, extendedProperties: { private: event.private }, etag: '"v1"' });
const initial = (r = record()) => google(plan([r], [], "2026-09-21").create[0]);

describe("calendar identity and reconciliation", () => {
  test("first import then a stateless rerun performs no writes", () => {
    const first = plan([record()], [], "2026-09-21");
    expect(first.create).toHaveLength(1);
    expect(first.create[0].id).toMatch(/^[a-f0-9]{64}$/);
    const second = plan([record()], [google(first.create[0])], "2026-09-21");
    expect(second.create).toHaveLength(0); expect(second.update).toHaveLength(0); expect(second.unchanged).toBe(1);
  });
  for (const status of ["Planned", "Confirmed", "On hold", "Completed", "Cancelled"]) {
    test(`renames and ${status} update the same ID`, () => {
      const next = record({ title: "Renamed event", status });
      const result = plan([next], [initial()], "2026-09-21");
      expect(result.create).toHaveLength(0);
      expect(result.update[0].next.id).toBe(eventId(record()));
      expect(result.update[0].next.summary).toStartWith(`[${status}] Renamed event`);
      if (status === "Cancelled") expect(result.update[0].next.transparency).toBe("transparent");
    });
  }
  test("rescheduled dates and clearing location update in place", () => {
    const result = plan([record({ start: { date: "2026-12-10" }, end: { date: "2026-12-11" }, location: "" })], [initial()], "2026-09-21");
    expect(result.update[0].next.start).toEqual({ date: "2026-12-10" });
    expect(result.update[0].next.location).toBe("");
  });
  test("unlinked human match is a conflict, despite title casing/status labels", () => {
    const human = { ...initial(), id: "human", summary: "original NAME  ", extendedProperties: undefined };
    const result = plan([record()], [human], "2026-09-21");
    expect(result.conflicts).toHaveLength(1); expect(result.create).toHaveLength(0); expect(result.update).toHaveLength(0);
  });
  test("explicit legacy link preserves notes, time, and stable identity after adoption", () => {
    const old: CalendarEvent = { id: "legacy", summary: "Old manual name", description: "Keep this note", start: { dateTime: "2026-10-10T08:15:00+02:00" }, end: { dateTime: "2026-10-10T17:30:00+02:00" }, etag: '"old"' };
    const link = { namespace: "crm.events", id: "stable-id", calendarEventId: "legacy" };
    const next = plan([record()], [old], "2026-09-21", [link]).update[0].next;
    expect(next.id).toBe("legacy"); expect(next.summary).toBe("[Planned] Original name");
    expect(next.start.dateTime).toBe("2026-10-10T06:15:00.000Z");
    expect(next.description).toContain("Keep this note"); expect(next.description).toContain("Calendar-supplied time retained");
    expect(plan([record()], [google(next)], "2026-09-21").unchanged).toBe(1);
    const moved = record({ start: { date: "2026-11-10" }, end: { date: "2026-11-11" } });
    const rescheduled = plan([moved], [google(next)], "2026-09-21").update[0].next;
    expect(rescheduled.start.dateTime).toBe("2026-11-10T07:15:00.000Z");
  });
  test("Google offset rendering compares equal to UTC and does not cause repeated patches", () => {
    const r = record({ timing: "exact", start: { dateTime: "2026-10-10T15:00:00Z" }, end: { dateTime: "2026-10-10T16:00:00Z" } });
    const old = initial(r); old.start = { dateTime: "2026-10-10T17:00:00+02:00", timeZone: "Europe/Stockholm" }; old.end = { dateTime: "2026-10-10T18:00:00+02:00" };
    expect(plan([r], [old], "2026-09-21").unchanged).toBe(1);
  });
  test("missing source records are reported, never deleted", () => {
    const result = plan([], [initial()], "2026-09-21", [], [], ["crm.events"]);
    expect(result.missing).toHaveLength(1); expect(result.update).toHaveLength(0); expect(result.create).toHaveLength(0);
  });
  test("skipped invalid source record is not reported deleted", () => {
    const result = plan([], [initial()], "2026-09-21", [], ["crm.events:stable-id"], ["crm.events"]);
    expect(result.missing).toHaveLength(0);
  });
  test("website source can share the planner without colliding with CRM IDs", () => {
    const web = record({ namespace: "website.events", title: "Website event" });
    const result = plan([record(), web], [], "2026-09-21");
    expect(result.create).toHaveLength(2); expect(result.create[0].id).not.toBe(result.create[1].id);
  });
  test("duplicate source IDs abort instead of emitting duplicate writes", () => {
    expect(() => plan([record(), record()], [], "2026-09-21")).toThrow("Duplicate source");
  });
  test("historical linked entries still update without historical backfill", () => {
    const old = record({ start: { date: "2026-01-01" }, end: { date: "2026-01-02" } });
    expect(plan([old], [], "2026-09-21").create).toHaveLength(0);
    const stored = google(plan([old], [], "2025-12-01").create[0]);
    expect(plan([{ ...old, title: "Updated" }], [stored], "2026-09-21").update).toHaveLength(1);
  });
});

describe("CRM normalization and complete snapshots", () => {
  test("explicit GMT range keeps its offset", () => {
    const { records } = normalizeCrm("events", [{ id: "a", title: "Research", status: "Planned", date: "2026-09-24", duration: "5:15 PM - 6:45 PM GMT+2" }]);
    expect(records[0].start.dateTime).toBe("2026-09-24T15:15:00.000Z");
    expect(records[0].end.dateTime).toBe("2026-09-24T16:45:00.000Z");
  });
  test("duration alone remains a transparent all-day placeholder", () => {
    const { records } = normalizeCrm("events", [{ id: "a", title: "Workshop", status: "Planned", date: "2026-10-10", duration: "3" }]);
    const event = plan(records, [], "2026-09-21").create[0];
    expect(event.start.date).toBe("2026-10-10"); expect(event.end.date).toBe("2026-10-11");
    expect(event.summary).toContain("[Time TBD]"); expect(event.transparency).toBe("transparent");
  });
  test("estimated meeting crossing midnight ends on the next day", () => {
    const { records } = normalizeCrm("meetings", [{ id: "a", title: "Meeting", meeting_date: "2026-12-01", meeting_time: "23:30:00" }]);
    expect(records[0].start.dateTime).toBe("2026-12-01T22:30:00.000Z");
    expect(records[0].end.dateTime).toBe("2026-12-01T23:30:00.000Z");
    expect(records[0].details).toContain("estimated at 60 minutes");
  });
  test("invalid dates and missing dates are reported and never guessed", () => {
    const result = normalizeCrm("events", [{ id: "a", title: "X", status: "Planned", date: "2026-02-30" }, { id: "b", title: "Y", date: null }]);
    expect(result.records).toHaveLength(0); expect(result.issues).toHaveLength(2); expect(result.keys).toHaveLength(2);
  });
  test("reads beyond the 200-row cap with stable offsets", async () => {
    const read = mock(async (spec: any) => ({ rows: Array.from({ length: spec.offset === 0 ? 200 : 1 }, (_, i) => ({ id: String(spec.offset + i) })), truncated: false, total: null }));
    expect(await readCrmPages("events", "id", read)).toHaveLength(201);
    expect(read.mock.calls[1][0].offset).toBe(200);
  });
  test("rejects truncated pages", async () => {
    expect(readCrmPages("events", "id", async () => ({ rows: [], truncated: true, total: null }))).rejects.toThrow("incomplete");
  });
  test("source failure prevents any calendar writes", async () => {
    const source: CalendarSource = { namespaces: ["crm.events"], list: async () => { throw new Error("unavailable"); } };
    const create = mock(async (e: SyncEventInput) => google(e));
    await expect(runSync({ sources: [source], apply: true, calendar: { list: async () => [], create, patch: async () => initial() } })).rejects.toThrow("unavailable");
    expect(create).not.toHaveBeenCalled();
  });
  test("dry-run defaults to no mutations", async () => {
    const source: CalendarSource = { namespaces: ["crm.events"], list: async () => ({ records: [record()], keys: ["crm.events:stable-id"], issues: [] }) };
    const create = mock(async (e: SyncEventInput) => google(e));
    await runSync({ sources: [source], date: "2026-09-21", calendar: { list: async () => [], create, patch: async () => initial() } });
    expect(create).not.toHaveBeenCalled();
  });
});
