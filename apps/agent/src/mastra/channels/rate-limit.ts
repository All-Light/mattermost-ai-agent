// In-memory sliding-window per-user rate limiter; resets on restart (abuse guard, not billing control).

type Bucket = {
  count: number;
  windowStart: number;
};

const buckets = new Map<string, Bucket>();

// High bounds so day-to-day use is never affected; only scripts/runaway loops get cut off.
const DEFAULT_LIMITS = {
  perMinute: 20,
  perDay: 300,
};

function windowKey(userId: string, windowMs: number): string {
  return `${userId}:${Math.floor(Date.now() / windowMs)}`;
}

/** Returns a human-readable reason when over a limit, else undefined (increments the window count). */
export function checkRateLimit(
  userId: string,
  limits: { perMinute?: number; perDay?: number } = {},
): string | undefined {
  const perMinute = limits.perMinute ?? DEFAULT_LIMITS.perMinute;
  const perDay = limits.perDay ?? DEFAULT_LIMITS.perDay;

  const now = Date.now();
  const minute = windowKey(userId, 60_000);
  const day = windowKey(userId, 86_400_000);

  const m = buckets.get(minute) ?? { count: 0, windowStart: now };
  const d = buckets.get(day) ?? { count: 0, windowStart: now };

  if (d.count >= perDay) return `daily limit (${perDay}/day) reached`;
  if (m.count >= perMinute) return `rate limit (${perMinute}/minute) reached`;

  buckets.set(minute, { count: m.count + 1, windowStart: m.windowStart });
  buckets.set(day, { count: d.count + 1, windowStart: d.windowStart });

  // Opportunistic cleanup: drop buckets whose window has fully elapsed.
  if (buckets.size > 10_000) {
    for (const [key, bucket] of buckets) {
      const [, start] = key.split(":");
      if (bucket.windowStart < now - 86_400_000) buckets.delete(key);
    }
  }
  return undefined;
}

export const RATE_LIMIT_LIMITS = DEFAULT_LIMITS;
