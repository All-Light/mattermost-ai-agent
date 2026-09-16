// Retries channel initialization when the first attempt fails.
//
// Mastra initializes an agent's channels once, from the Mastra constructor,
// and only logs the error when that fails. A transient DNS failure at boot
// (the Pi starts the agent at 06:00 while the router's resolver is still
// waking up) then leaves the process alive but the bot deaf: no websocket, no
// bot identity, and systemd sees a healthy service so it never restarts it.
//
// AgentChannels.initialize() clears its cached promise on failure and builds a
// fresh Chat instance on the next call, so a retry loop is all that is needed.
import type { Mastra } from "@mastra/core";
import type { Agent } from "@mastra/core/agent";

// Retry quickly while the network is probably just settling, then back off so
// a real outage does not fill the journal.
export const FAST_RETRY_INTERVAL_MS = 15_000;
export const FAST_RETRY_WINDOW_MS = 4 * 60_000;
export const SLOW_RETRY_INTERVAL_MS = 10 * 60_000;

/** Delay before retry number `attempt` (1-based). */
export function retryDelayMs(attempt: number): number {
  const fastAttempts = Math.floor(FAST_RETRY_WINDOW_MS / FAST_RETRY_INTERVAL_MS);
  return attempt <= fastAttempts ? FAST_RETRY_INTERVAL_MS : SLOW_RETRY_INTERVAL_MS;
}

// The adapter wraps network errors twice (NetworkError -> fetch failed ->
// EAI_AGAIN); the innermost message is the one worth reading in the journal.
function describe(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && parts.length < 4) {
    parts.push(current.message);
    const wrapped = current as Error & { originalError?: unknown };
    current = wrapped.cause ?? wrapped.originalError;
  }
  return parts.length ? parts.join(": ") : String(error);
}

/**
 * Keeps calling `agent.getChannels().initialize(mastra)` until the channel
 * SDK is up. Resolves immediately if the agent has no channels. Only the
 * initial connection is covered here: once connected, the Mattermost adapter
 * reconnects its websocket on its own.
 */
export function ensureChannelsInitialized(mastra: Mastra, agent: Agent): void {
  const channels = agent.getChannels();
  if (!channels) return;

  const label = agent.id;
  let attempt = 0;

  const schedule = (delayMs: number) => {
    const timer = setTimeout(() => void tryInitialize(), delayMs);
    // Do not hold the process open purely for the retry timer.
    timer.unref?.();
  };

  const tryInitialize = async () => {
    // Mastra's own attempt from the constructor may have succeeded meanwhile.
    if (channels.sdk) return;
    attempt += 1;
    try {
      await channels.initialize(mastra);
      console.log(`[channels] ${label} channels initialized on retry ${attempt}`);
    } catch (error) {
      const delayMs = retryDelayMs(attempt + 1);
      console.warn(
        `[channels] ${label} channels retry ${attempt} failed: ${describe(error)} — next attempt in ${delayMs / 1000}s`,
      );
      schedule(delayMs);
    }
  };

  schedule(retryDelayMs(1));
}
