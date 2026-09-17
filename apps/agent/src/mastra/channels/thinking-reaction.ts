// A 👀 on the member's message for as long as the agent is working on it.
//
// The typing indicator alone is easy to miss in a busy channel, and it says
// nothing once it stops — a member cannot tell a slow answer from one that was
// never coming. A reaction sits on their own message until the reply lands.
import type { Message, Thread } from "chat";

/** A WellKnownEmoji, so adapters map it themselves rather than us sending raw unicode. */
const THINKING = "eyes";

export async function whileThinking<T>(
  thread: Thread,
  message: Message,
  work: () => Promise<T>,
): Promise<T> {
  let sent;
  try {
    sent = thread.createSentMessageFromMessage(message);
  } catch (error) {
    // No handle on the message — answer anyway; the reaction is a nicety.
    console.warn("[thinking] could not wrap message for reactions:", describe(error));
    return work();
  }

  const added = sent
    .addReaction(THINKING)
    .then(() => true)
    .catch((error) => {
      console.warn("[thinking] could not add reaction:", describe(error));
      return false;
    });

  try {
    return await work();
  } finally {
    // `finally`, so a failed or aborted turn does not strand the 👀 on a
    // message the agent has stopped working on.
    if (await added) {
      await sent.removeReaction(THINKING).catch((error) => {
        console.warn("[thinking] could not remove reaction:", describe(error));
      });
    }
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
