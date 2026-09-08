// UUAIS runs on Uppsala time, and members will say "tomorrow at 09:00" without
// ever thinking about offsets. A bare timestamp is therefore interpreted as
// Europe/Stockholm wall-clock time rather than UTC, which would silently drift
// by one or two hours depending on the season.
export const SOCIETY_TIMEZONE = "Europe/Stockholm";

/** Offset of the society timezone, in ms, at a given instant (DST-aware). */
function timezoneOffsetMs(instant: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: SOCIETY_TIMEZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }

  // Re-read the local wall clock as if it were UTC; the gap is the offset.
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instant.getTime();
}

const HAS_EXPLICIT_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse an ISO-8601 timestamp into epoch ms. A string carrying its own zone is
 * honoured as-is; a bare one ("2026-09-08T09:00") is read as society-local time.
 * Two passes because the offset itself depends on the instant we are resolving.
 */
export function parseWhen(input: string): number {
  const value = input.trim();
  if (!value) throw new Error("Empty timestamp");

  if (HAS_EXPLICIT_ZONE.test(value)) {
    const explicit = Date.parse(value);
    if (Number.isNaN(explicit)) throw new Error(`Could not parse "${input}" as a timestamp`);
    return explicit;
  }

  const normalised = value.includes("T") ? value : `${value}T09:00:00`;
  const naive = Date.parse(`${normalised}Z`);
  if (Number.isNaN(naive)) {
    throw new Error(`Could not parse "${input}". Use ISO-8601, e.g. 2026-09-08T09:00.`);
  }

  let epoch = naive - timezoneOffsetMs(new Date(naive));
  // One correction pass fixes the case where the first guess landed on the far
  // side of a DST switch from the real instant.
  epoch = naive - timezoneOffsetMs(new Date(epoch));
  return epoch;
}

/** Render epoch ms the way a member would read it back, in society time. */
export function formatWhen(epochMs: number): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: SOCIETY_TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(epochMs));
}
