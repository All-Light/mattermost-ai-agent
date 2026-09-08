// Tools for the shared UUAIS events calendar.
//
// The calendar id is never a parameter — it comes from GOOGLE_CALENDAR_ID — so
// these tools can only ever act on the one calendar the service account was
// given access to.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  calendarConfigured,
  createEvent,
  deleteEvent,
  getEvent,
  isAgentCreated,
  listEvents,
  patchEvent,
  type CalendarEvent,
} from "../google/calendar";
import { SOCIETY_TIMEZONE } from "../reminders/time";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function requireCalendar(): void {
  if (!calendarConfigured()) {
    throw new Error(
      "The shared calendar is not configured yet (GOOGLE_CALENDAR_ID and service account credentials).",
    );
  }
}

/** A bare date means an all-day event; anything else is a timed one. */
function toTime(value: string): { date?: string; dateTime?: string } {
  return DATE_ONLY.test(value.trim()) ? { date: value.trim() } : { dateTime: value.trim() };
}

/** Google treats all-day `end.date` as exclusive, so a one-day event ends the
 *  following day. Without this a "Friday" event silently disappears. */
function exclusiveEnd(end: string): string {
  if (!DATE_ONLY.test(end)) return end;
  const d = new Date(`${end}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function summarise(event: CalendarEvent) {
  return {
    id: event.id,
    title: event.summary ?? "(untitled)",
    start: event.start?.dateTime ?? event.start?.date ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    location: event.location ?? null,
    link: event.htmlLink ?? null,
    created_by_bot: isAgentCreated(event),
  };
}

export const listCalendarEvents = createTool({
  id: "list_calendar_events",
  description:
    "List events on the shared UUAIS calendar. Use this for what is actually " +
    "scheduled; the CRM holds planning data, the calendar holds the real dates.",
  inputSchema: z.object({
    from: z.string().optional().describe('ISO date or datetime, default now. e.g. "2026-09-08"'),
    to: z.string().optional().describe("ISO date or datetime, default 30 days out"),
    query: z.string().optional().describe("Free-text match on title/description"),
    limit: z.number().int().min(1).max(250).optional(),
  }),
  execute: async ({ from, to, query, limit }) => {
    requireCalendar();
    const timeMin = from ? new Date(from).toISOString() : new Date().toISOString();
    const timeMax = to
      ? new Date(to).toISOString()
      : new Date(Date.now() + 30 * 86_400_000).toISOString();

    const events = await listEvents({ timeMin, timeMax, q: query, maxResults: limit });
    return { timezone: SOCIETY_TIMEZONE, count: events.length, events: events.map(summarise) };
  },
});

export const createCalendarEvent = createTool({
  id: "create_calendar_event",
  description:
    "Add an event to the shared UUAIS calendar. Confirm title, date and time with " +
    "the requester before calling. Times without a timezone are Uppsala local time.",
  inputSchema: z.object({
    title: z.string(),
    start: z.string().describe('"2026-09-08" for all-day, or "2026-09-08T18:00" for a timed event'),
    end: z.string().describe("Same format as start. For all-day events give the last day itself."),
    description: z.string().optional(),
    location: z.string().optional(),
    requested_by: z.string().optional().describe("Who asked for this, recorded on the event"),
  }),
  execute: async ({ title, start, end, description, location, requested_by }) => {
    requireCalendar();
    const created = await createEvent({
      summary: title,
      description,
      location,
      start: toTime(start),
      end: toTime(exclusiveEnd(end)),
      requestedBy: requested_by,
    });
    return { created: summarise(created) };
  },
});

export const updateCalendarEvent = createTool({
  id: "update_calendar_event",
  description:
    "Change an event on the shared UUAIS calendar. Pass only the fields you are " +
    "changing; get the id from list_calendar_events first.",
  inputSchema: z.object({
    id: z.string().describe("Event id from list_calendar_events"),
    title: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
  }),
  // Editing the bot's own entries is routine; editing something a person put on
  // the calendar by hand is not, so only that case interrupts someone.
  requireApproval: async ({ id }) => {
    if (!id || !calendarConfigured()) return true;
    try {
      return !isAgentCreated(await getEvent(id));
    } catch {
      // Cannot establish provenance — ask.
      return true;
    }
  },
  execute: async ({ id, title, start, end, description, location }) => {
    requireCalendar();
    if (!title && !start && !end && description === undefined && location === undefined) {
      throw new Error("Nothing to update — pass at least one field.");
    }
    const updated = await patchEvent(id, {
      summary: title,
      description,
      location,
      start: start ? toTime(start) : undefined,
      end: end ? toTime(exclusiveEnd(end)) : undefined,
    });
    return { updated: summarise(updated) };
  },
});

export const deleteCalendarEvent = createTool({
  id: "delete_calendar_event",
  description:
    "Delete an event from the shared UUAIS calendar. Only events the bot created " +
    "can be deleted — ask a human to remove anything else.",
  // Deletion is unrecoverable from chat, so it always goes past a person.
  requireApproval: true,
  inputSchema: z.object({ id: z.string().describe("Event id from list_calendar_events") }),
  execute: async ({ id }) => {
    requireCalendar();
    const event = await getEvent(id);
    if (!isAgentCreated(event)) {
      throw new Error(
        `"${event.summary ?? id}" was not created by the bot, so it will not be deleted. ` +
          "Remove it in Google Calendar directly.",
      );
    }
    await deleteEvent(id);
    return { deleted: true, id, title: event.summary ?? null };
  },
});

export const calendarTools = {
  list_calendar_events: listCalendarEvents,
  create_calendar_event: createCalendarEvent,
  update_calendar_event: updateCalendarEvent,
  delete_calendar_event: deleteCalendarEvent,
};
