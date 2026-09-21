// Google Calendar access for the shared UUAIS events calendar.
//
// Deliberately narrow, in three independent ways:
//   1. The OAuth scope is calendar.events — event CRUD only. It cannot read or
//      change who a calendar is shared with, and cannot enumerate calendars.
//   2. The calendar id is pinned from the environment and is never a tool
//      parameter, so the agent cannot be talked into touching another calendar.
//   3. Events the agent creates are tagged, so it can tell its own entries from
//      ones people made by hand and treat those more carefully.
//
// The service account itself holds no IAM roles; its entire reach is whatever
// the calendar's sharing settings grant it.
import { googleCredentials, scopedJwt } from "./auth";
import { SOCIETY_TIMEZONE } from "../reminders/time";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API_BASE = "https://www.googleapis.com/calendar/v3";

/** Marks events this agent created, so it can refuse to delete human ones. */
export const AGENT_TAG = "uuais-mattermost-agent";

export function calendarId(): string | null {
  return process.env.GOOGLE_CALENDAR_ID?.trim() || null;
}

export function calendarConfigured(): boolean {
  return googleCredentials() !== null && calendarId() !== null;
}

function jwt() {
  return scopedJwt(
    [SCOPE],
    "Google Calendar is not configured. Set GOOGLE_CALENDAR_ID plus either " +
      "GOOGLE_SERVICE_ACCOUNT_KEY_FILE or GOOGLE_SERVICE_ACCOUNT_EMAIL/_PRIVATE_KEY.",
  );
}

async function calFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const id = calendarId();
  if (!id) throw new Error("GOOGLE_CALENDAR_ID is not set.");

  const { token } = await jwt().getAccessToken();
  const response = await fetch(`${API_BASE}/calendars/${encodeURIComponent(id)}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let detail = body.slice(0, 300);
    try {
      detail = JSON.parse(body)?.error?.message ?? detail;
    } catch {
      /* keep the truncated body */
    }
    // The two failures worth naming, because the fix is completely different.
    if (response.status === 404) {
      throw new Error(
        `Calendar not found or not shared with the bot. Share it with the service ` +
          `account and check GOOGLE_CALENDAR_ID. (${detail})`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Calendar access denied — the key may have expired, or the calendar is shared ` +
          `with less than "Make changes to events". (${detail})`,
      );
    }
    throw new Error(`Calendar API ${response.status}: ${detail}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export type CalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
  recurrence?: string[];
  etag?: string;
  transparency?: "opaque" | "transparent";
};

/** True when this agent created the event, per its own tag. */
export function isAgentCreated(event: CalendarEvent): boolean {
  return event.extendedProperties?.private?.createdBy === AGENT_TAG;
}

export async function listEvents(opts: {
  timeMin?: string;
  timeMax?: string;
  q?: string;
  maxResults?: number;
}): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(Math.min(Math.max(opts.maxResults ?? 25, 1), 250)),
  });
  if (opts.timeMin) params.set("timeMin", opts.timeMin);
  if (opts.timeMax) params.set("timeMax", opts.timeMax);
  if (opts.q) params.set("q", opts.q);

  const data = await calFetch<{ items?: CalendarEvent[] }>(`/events?${params}`);
  return data.items ?? [];
}

/** Lists every event. Used by deterministic synchronizers, never by chat tools. */
export async function listAllEvents(): Promise<CalendarEvent[]> {
  const items: CalendarEvent[] = [];
  let token: string | undefined;
  const seen = new Set<string>();
  do {
    const params = new URLSearchParams({ singleEvents: "false", showDeleted: "false", maxResults: "2500" });
    if (token) params.set("pageToken", token);
    const page = await calFetch<{ items?: CalendarEvent[]; nextPageToken?: string }>(`/events?${params}`);
    if (page.items && !Array.isArray(page.items)) throw new Error("Invalid Calendar events page");
    items.push(...(page.items ?? []));
    token = page.nextPageToken;
    if (token && seen.has(token)) throw new Error("Calendar pagination repeated a token");
    if (token) seen.add(token);
  } while (token);
  return items;
}

export async function getEvent(eventId: string): Promise<CalendarEvent> {
  return calFetch<CalendarEvent>(`/events/${encodeURIComponent(eventId)}`);
}

type TimeInput = { dateTime?: string; date?: string };

/** All-day events use `date`; timed ones carry the society timezone explicitly
 *  so a naive local string is never read as UTC by Google. */
function toGoogleTime(value: TimeInput) {
  if (value.date) return { date: value.date };
  return { dateTime: value.dateTime, timeZone: SOCIETY_TIMEZONE };
}

export async function createEvent(input: {
  summary: string;
  description?: string;
  location?: string;
  start: TimeInput;
  end: TimeInput;
  requestedBy?: string;
}): Promise<CalendarEvent> {
  return calFetch<CalendarEvent>("/events", {
    method: "POST",
    body: JSON.stringify({
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: toGoogleTime(input.start),
      end: toGoogleTime(input.end),
      extendedProperties: {
        private: {
          createdBy: AGENT_TAG,
          ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
        },
      },
    }),
  });
}

export async function patchEvent(
  eventId: string,
  patch: {
    summary?: string;
    description?: string;
    location?: string;
    start?: TimeInput;
    end?: TimeInput;
  },
): Promise<CalendarEvent> {
  const body: Record<string, unknown> = {};
  if (patch.summary !== undefined) body.summary = patch.summary;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.location !== undefined) body.location = patch.location;
  if (patch.start) body.start = toGoogleTime(patch.start);
  if (patch.end) body.end = toGoogleTime(patch.end);

  return calFetch<CalendarEvent>(`/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function deleteEvent(eventId: string): Promise<void> {
  await calFetch<void>(`/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
}

export type SyncEventInput = {
  id: string; summary: string; description: string; location?: string;
  start: TimeInput; end: TimeInput; transparency?: "opaque" | "transparent";
  private: Record<string, string>;
};

// Clear the other representation when changing between all-day and timed events.
function syncTime(time: TimeInput) {
  return { date: time.date ?? null, dateTime: time.dateTime ?? null,
    timeZone: time.date ? null : SOCIETY_TIMEZONE };
}

/** Creates a deterministic, synchronizer-owned event. Google returns 409 when its id already exists. */
export async function createSyncEvent(input: SyncEventInput): Promise<CalendarEvent> {
  return calFetch<CalendarEvent>("/events", { method: "POST", body: JSON.stringify({
    id: input.id, summary: input.summary, description: input.description, location: input.location,
    start: syncTime(input.start), end: syncTime(input.end), transparency: input.transparency,
    extendedProperties: { private: input.private },
  }) });
}

/** Patches only sync-owned fields. `If-Match` protects human edits between read and write. */
export async function patchSyncEvent(eventId: string, input: SyncEventInput, etag: string): Promise<CalendarEvent> {
  return calFetch<CalendarEvent>(`/events/${encodeURIComponent(eventId)}`, { method: "PATCH", headers: etag ? { "If-Match": etag } : undefined, body: JSON.stringify({
    summary: input.summary, description: input.description, location: input.location,
    start: syncTime(input.start), end: syncTime(input.end), transparency: input.transparency,
    extendedProperties: { private: input.private },
  }) });
}
