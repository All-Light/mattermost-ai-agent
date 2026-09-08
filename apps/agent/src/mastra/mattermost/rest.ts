// Thin Mattermost REST v4 client for the things the chat adapter does not expose:
// looking a member up by email/username and opening a DM channel with them.
// The adapter owns the WebSocket and normal replies; this is only for the bot
// reaching out to someone unprompted (reminders, nudges).

const CACHE_TTL_MS = 5 * 60_000;

type MattermostUser = {
  id: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  delete_at: number;
};

function config(): { baseUrl: string; token: string } | null {
  const baseUrl = process.env.MATTERMOST_BASE_URL?.replace(/\/$/, "");
  const token = process.env.MATTERMOST_BOT_TOKEN;
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

export function mattermostConfigured(): boolean {
  return config() !== null;
}

async function mmFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const cfg = config();
  if (!cfg) throw new Error("MATTERMOST_BASE_URL / MATTERMOST_BOT_TOKEN are not set");

  const response = await fetch(`${cfg.baseUrl}/api/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // Mattermost returns a JSON error envelope; surface its message, not the raw HTML.
    let detail = body.slice(0, 200);
    try {
      const parsed = JSON.parse(body);
      if (parsed?.message) detail = parsed.message;
    } catch {
      /* keep the truncated body */
    }
    throw new Error(`Mattermost ${init?.method ?? "GET"} ${path} failed (${response.status}): ${detail}`);
  }

  return (await response.json()) as T;
}

let botId: { id: string; at: number } | null = null;

export async function getBotUserId(): Promise<string> {
  if (botId && Date.now() - botId.at < CACHE_TTL_MS) return botId.id;
  const me = await mmFetch<MattermostUser>("/users/me");
  botId = { id: me.id, at: Date.now() };
  return me.id;
}

const userCache = new Map<string, { user: MattermostUser; at: number }>();

/**
 * Resolve a member from an @username, a bare username, or an email address.
 * Email is the reliable key when coming from the CRM, since Business Hub
 * accounts and Mattermost accounts share it but usernames may differ.
 */
export async function resolveUser(ref: string): Promise<MattermostUser> {
  const needle = ref.trim().replace(/^@/, "");
  if (!needle) throw new Error("Empty user reference");

  const cached = userCache.get(needle.toLowerCase());
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.user;

  const path = needle.includes("@")
    ? `/users/email/${encodeURIComponent(needle)}`
    : `/users/username/${encodeURIComponent(needle)}`;

  let user: MattermostUser;
  try {
    user = await mmFetch<MattermostUser>(path);
  } catch (error) {
    throw new Error(
      `No Mattermost account for "${ref}". ` +
        (needle.includes("@")
          ? "Their Business Hub email may differ from their Mattermost email."
          : "Try their email address instead.") +
        ` (${error instanceof Error ? error.message : error})`,
    );
  }

  if (user.delete_at > 0) throw new Error(`The Mattermost account for "${ref}" is deactivated.`);

  userCache.set(needle.toLowerCase(), { user, at: Date.now() });
  return user;
}

/**
 * Look up a member by their Mattermost user id.
 *
 * The adapter falls back to the raw user id when its own user fetch fails
 * (`userName: user?.username ?? fallbackUserId`), so anything doing an identity
 * check has to be able to recover the real username rather than trusting the
 * value it was handed.
 */
export async function getUserById(userId: string): Promise<MattermostUser | null> {
  const cached = userCache.get(`id:${userId}`);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.user;
  try {
    const user = await mmFetch<MattermostUser>(`/users/${encodeURIComponent(userId)}`);
    userCache.set(`id:${userId}`, { user, at: Date.now() });
    return user;
  } catch {
    return null;
  }
}

export async function openDirectChannel(userId: string): Promise<string> {
  const bot = await getBotUserId();
  const channel = await mmFetch<{ id: string }>("/channels/direct", {
    method: "POST",
    body: JSON.stringify([bot, userId]),
  });
  return channel.id;
}

export async function postMessage(channelId: string, message: string): Promise<string> {
  const post = await mmFetch<{ id: string }>("/posts", {
    method: "POST",
    body: JSON.stringify({ channel_id: channelId, message }),
  });
  return post.id;
}

/** Resolve → open DM → post. Returns the delivery details for the audit trail. */
export async function directMessage(
  ref: string,
  message: string,
): Promise<{ username: string; userId: string; channelId: string; postId: string }> {
  const user = await resolveUser(ref);
  const channelId = await openDirectChannel(user.id);
  const postId = await postMessage(channelId, message);
  return { username: user.username, userId: user.id, channelId, postId };
}

export type { MattermostUser };
