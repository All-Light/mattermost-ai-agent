// `!help` — what the bot can actually do right now.
//
// Built from the live configuration rather than a hand-written list, so a
// disabled integration is reported as disabled instead of being advertised and
// then failing when someone tries it.
import type { Message, Thread } from "chat";
import { crmMcp } from "../mcp/crm-mcp";
import { uuaisMcp } from "../mcp/uuais-mcp";
import { githubMcp, GITHUB_ORG } from "../mcp/github-mcp";
import { calendarConfigured } from "../google/calendar";
import { sandboxAvailable } from "../tools/sandbox";
import { mattermostConfigured } from "../mattermost/rest";
import { inboxConfigured, inboxAddress } from "../google/inbox";
import { webSearchConfigured } from "../web/exa";
import { driveConfigured } from "../google/drive";
import { getModel } from "../settings/store";

const COMMANDS = ["!help", "/help", ".help", "./help"] as const;

type Section = { title: string; enabled: boolean; lines: string[]; disabledNote?: string };

function sections(): Section[] {
  return [
    {
      title: "🌐 UUAIS website",
      enabled: !!uuaisMcp,
      lines: [
        '"How many members do we have on the website?"',
        '"What events are coming up?"',
        '"Which courses need linear algebra first?"',
        '"Are there any open board positions right now?"',
      ],
      disabledNote: "needs `MCP_ADMIN_TOKEN`",
    },
    {
      title: "📊 Business Hub (CRM)",
      enabled: !!crmMcp,
      lines: [
        '"What\'s coming up in the next two weeks?"',
        '"Which outreach deals are stale?"',
        '"Who is assigned to the lunch lecture?"',
        '"Create a task for William to follow up with the sponsor, due Friday."',
      ],
      disabledNote: "needs `CRM_MCP_TOKEN` and the Business Hub MCP endpoint deployed",
    },
    {
      title: "📅 Shared calendar",
      enabled: calendarConfigured(),
      lines: [
        '"Update tomorrow\'s event to start at 17:00 instead of 16:00."',
        '"What\'s on the calendar next week?"',
        '"Add a board meeting on the 20th at 18:00 in Ångström."',
      ],
      disabledNote: "needs `GOOGLE_CALENDAR_ID` and service-account credentials",
    },
    {
      title: "⏰ Reminders",
      enabled: mattermostConfigured(),
      lines: [
        '"Remind Alexander to publish the blog post on Thursday morning."',
        '"Remind me in 90 minutes to send the sponsor email."',
        '"What reminders are pending?"',
      ],
      disabledNote: "needs Mattermost credentials",
    },
    {
      title: "🐙 GitHub",
      enabled: !!githubMcp,
      lines: [
        `"What repos does ${GITHUB_ORG} have?"`,
        '"Summarise the open pull requests."',
        '"What does the README of the website repo say about deployment?"',
      ],
      disabledNote: "needs `GITHUB_TOKEN`",
    },
    {
      title: "📂 Shared drive",
      enabled: driveConfigured(),
      lines: [
        '"What does the handover doc say about sponsorship pricing?"',
        '"Find anything in the drive about the spring hackathon."',
        "_(read-only — I can't edit documents)_",
      ],
      disabledNote: "needs the drive shared with the service account",
    },
    {
      title: "🔎 Web search",
      enabled: webSearchConfigured(),
      lines: [
        '"Find recent papers on retrieval-augmented generation."',
        '"What does this company do?" (paste a link)',
        '"Which other Swedish universities have an AI society?"',
      ],
      disabledNote: "needs `EXA_API_KEY`",
    },
    {
      title: "📥 Bot mailbox",
      enabled: inboxConfigured(),
      lines: [
        `"Anything new in ${inboxAddress() ?? "the bot inbox"}?"`,
        '"Summarise the unread mail."',
        '"Search my inbox for anything from tldv."',
        "_(read-only — I can't send or reply)_",
      ],
      disabledNote: "needs `GOOGLE_BOT_NAME` and an app password in `GOOGLE_BOT_PASSWORD`",
    },
    {
      title: "🧮 Scratch shell",
      enabled: sandboxAvailable(),
      lines: [
        '"Work out the per-head cost if the venue is 4200 kr for 35 people."',
        '"Parse this CSV I\'m pasting and total the third column."',
        "_(isolated: no network, no access to our systems)_",
        "I can also save a script as a reusable tool — ask me to remember a calculation.",
      ],
      disabledNote: "only available on the Pi deployment",
    },
  ];
}

export async function buildHelp(): Promise<string> {
  const all = sections();
  const on = all.filter((s) => s.enabled);
  const off = all.filter((s) => !s.enabled);

  const parts = [
    "### What I can help with",
    "",
    "Just talk to me normally — @mention me in a channel or DM me. Examples:",
    "",
  ];

  for (const section of on) {
    parts.push(`**${section.title}**`);
    for (const line of section.lines) parts.push(`- ${line}`);
    parts.push("");
  }

  parts.push("I can also summarise a thread, review writing or code, and explain AI/ML concepts.");
  parts.push("");
  parts.push("**Commands**");
  parts.push("- `!help` — this message");
  parts.push("- `!model` — show the model; maintainers can change it (currently `" + (await getModel()) + "`)");
  parts.push("");

  if (off.length) {
    parts.push("**Not switched on yet:** " + off.map((s) => `${s.title.replace(/^\S+\s/, "")} (${s.disabledNote})`).join(", ") + ".");
    parts.push("");
  }

  parts.push(
    "_Not yet possible: recurring background jobs, e.g. sweeping the website for " +
      "new applications and messaging you when one arrives. Reminders are one-off._",
  );

  return parts.join("\n");
}

/** Returns true when the message was `!help` and has been answered. */
export async function handleHelpCommand(thread: Thread, message: Message): Promise<boolean> {
  const text = (message.text ?? "").trim().replace(/^@[\w.\-]+\s+/, "");
  const lower = text.toLowerCase();
  const matched = [...COMMANDS]
    .sort((a, b) => b.length - a.length)
    .find((c) => lower === c || lower.startsWith(`${c} `));
  if (!matched) return false;

  await thread.post(await buildHelp());
  return true;
}
