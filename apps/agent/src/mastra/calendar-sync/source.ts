import type { CalendarEvent } from "../google/calendar";

export type SourceRecord = {
  namespace: string;
  id: string;
  title: string;
  status: string;
  start: NonNullable<CalendarEvent["start"]>;
  end: NonNullable<CalendarEvent["end"]>;
  timing: "exact" | "estimated" | "date-only";
  location: string;
  details: string;
};

export type SourceSnapshot = {
  records: SourceRecord[];
  // Include undated/invalid records so they are not mistaken for deleted ones.
  keys: string[];
  issues: string[];
};

/** A website adapter can supply this same normalized shape without changing the planner. */
export interface CalendarSource {
  namespaces: string[];
  list(): Promise<SourceSnapshot>;
}

export type ExistingLink = { namespace: string; id: string; calendarEventId: string };
export const sourceKey = (r: { namespace: string; id: string }) => `${r.namespace}:${r.id}`;
