// Polls the reminder queue and delivers due reminders as Mattermost DMs.
//
// A poll loop rather than one timer per reminder: timers do not survive a
// restart, and the queue is small enough that a 30-second sweep is cheaper than
// tracking them individually.
import { directMessage, mattermostConfigured } from "../mattermost/rest";
import { dueReminders, markFailed, markSent } from "./store";

const POLL_INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function deliverDue(): Promise<void> {
  // Overlapping sweeps would double-send anything slow, so one at a time.
  if (running) return;
  running = true;
  try {
    const due = await dueReminders();
    for (const reminder of due) {
      try {
        await directMessage(reminder.recipientRef, `⏰ **Reminder**\n\n${reminder.message}`);
        await markSent(reminder.id);
        console.log(`[reminders] delivered ${reminder.id} to ${reminder.recipientRef}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await markFailed(reminder.id, message);
        console.warn(`[reminders] delivery failed for ${reminder.id}: ${message}`);
      }
    }
  } catch (error) {
    // The queue lives in the same DB as agent memory; a blip here must not take
    // the whole agent down, so log and wait for the next sweep.
    console.warn("[reminders] sweep failed:", error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

export function startReminderScheduler(): void {
  if (timer) return;

  if (!mattermostConfigured()) {
    console.warn(
      "[reminders] MATTERMOST_BASE_URL / MATTERMOST_BOT_TOKEN are not set — reminder delivery is disabled.",
    );
    return;
  }

  timer = setInterval(() => void deliverDue(), POLL_INTERVAL_MS);
  // Do not hold the process open purely for the sweep timer.
  timer.unref?.();
  void deliverDue();
  console.log(`[reminders] scheduler started (every ${POLL_INTERVAL_MS / 1000}s)`);
}

export function stopReminderScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
