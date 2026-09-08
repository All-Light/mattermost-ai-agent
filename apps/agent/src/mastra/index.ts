import { Mastra } from "@mastra/core";
import { mattermostAgent, store } from "./agents/mattermost-agent";
import { startReminderScheduler } from "./reminders/scheduler";
import { initSettings } from "./settings/store";

export const mastra = new Mastra({
  agents: { mattermostAgent },
  storage: store,
});

// Scheduled reminders are delivered by a background sweep rather than by the
// agent loop, so they fire whether or not anyone is talking to the bot.
startReminderScheduler();

// Warm the settings cache so the first request does not pay for a DB read.
void initSettings();
