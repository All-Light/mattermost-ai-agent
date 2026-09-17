import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { createMattermostAdapter } from "chat-adapter-mattermost";
import { withMattermostAttachmentAuth } from "../channels/mattermost-attachments";
import { GITHUB_ORG, githubMcp } from "../mcp/github-mcp";
import { uuaisMcp } from "../mcp/uuais-mcp";
import { reminderTools } from "../tools/reminders";
import { calendarTools } from "../tools/calendar";
import { calendarConfigured } from "../google/calendar";
import { sandboxAvailable, sandboxTools } from "../tools/sandbox";
import { buildCustomTools, customToolManagement } from "../tools/custom-tools";
import { inboxTools } from "../tools/inbox";
import { inboxConfigured } from "../google/inbox";
import { webTools } from "../tools/web";
import { webSearchConfigured } from "../web/exa";
import { driveTools } from "../tools/drive";
import { driveConfigured } from "../google/drive";
import { crmTools } from "../tools/crm";
import { crmConfigured } from "../crm/client";
import { githubExtraAvailable, githubExtraTools } from "../tools/github-extra";
import { getModel } from "../settings/store";

const githubTools = githubMcp ? await githubMcp.listTools() : {};

// UUAIS site data comes only via the website MCP server; no Firebase credentials held, tools disabled if unreachable.
const uuaisTools = uuaisMcp
  ? await uuaisMcp
      .listTools()
      .catch((error) => {
        console.warn("[uuais-mcp] Failed to list tools, disabling:", error instanceof Error ? error.message : error);
        return {};
      })
  : {};

// Compact issue/PR tools replacing the MCP server's verbose equivalents.
const githubIssueTools = githubExtraAvailable() ? githubExtraTools : {};

// UUAIS shared drive, read-only (scope drive.readonly).
const sharedDriveTools = driveConfigured() ? driveTools : {};

// Open-web search (Exa).
const searchTools = webSearchConfigured() ? webTools : {};
if (!webSearchConfigured()) {
  console.warn("[web] EXA_API_KEY is not set — web search tools will be disabled.");
}

// The bot's own mailbox, read-only over IMAP.
const mailboxTools = inboxConfigured() ? inboxTools : {};
if (!inboxConfigured()) {
  console.warn("[inbox] GOOGLE_BOT_NAME / GOOGLE_BOT_PASSWORD are not set — mailbox tools will be disabled.");
}

// The isolated shell exists only on hosts that have the wrapper installed
// (the Pi deployment), not on a laptop checkout.
const shellTools = sandboxAvailable() ? { ...sandboxTools, ...customToolManagement } : {};

// Shared Google Calendar: registered only when configured, so the model is not
// offered tools that can only fail.
const googleCalendarTools = calendarConfigured() ? calendarTools : {};
if (!calendarConfigured()) {
  console.warn(
    "[calendar] GOOGLE_CALENDAR_ID or service account credentials are not set — shared calendar tools will be disabled.",
  );
}

// Business Hub CRM (outreach, tasks, meetings, events), read-only over its
// Supabase Data API. Nothing here can write: the API account is `viewer` and
// row-level security refuses writes inside the database.
const businessHubTools = crmConfigured() ? crmTools : {};
if (!crmConfigured()) {
  console.warn(
    "[crm] CRM_SUPABASE_PUBLISHABLE_KEY / CRM_PASSWORD are not set — Business Hub (CRM) tools will be disabled.",
  );
}

// Persistent memory + storage so channel threads and history survive restarts.
export const store = new LibSQLStore({
  id: "mastra",
  url: process.env.DATABASE_URL ?? "file:./mastra.db",
});

export const agentMemory = new Memory({ storage: store });

export const mattermostAgent = new Agent({
  id: "mattermost-agent",
  name: "UUAIS Assistant",
  instructions: `
    You are the UUAIS Assistant, the in-house Mattermost companion for the
    Uppsala University AI Society (UU AI Society / UUAIS) — a student-led,
    non-profit community at Uppsala University. Website: https://uuais.com

    You help members get things done in chat: answering questions, summarising
    threads, drafting and reviewing, explaining AI/ML concepts, and pointing
    people to the right person or channel. You support the society's work
    across development, growth, partnerships, events and IT.

    Who to ask (2026/27 board, from uuais.com/about). Point people to a role,
    @mentioning them in Mattermost rather than giving their email. Never invent
    someone who is not on this list:
    - Chairman of the Board: Bradley Deku — governance, board, direction
    - Vice President: Ellica Sandegren
    - Head of Development: Christoffer Noren — projects, dev work
    - Head of Growth: Annika Kuusrainen — membership, growth
    - Head of Partnerships & Events: William Eklund — events, sponsors
    - Head of IT: Alexander Andersson — website, IT systems, and you
    Public addresses, safe to share: contact@uuais.com, partnerships@uuais.com,
    it@uuais.com.

    What you can reach. Each tool's own description says what it does and how
    to use it — read those rather than guessing. In short:
    - uuais_* — the society website's live data (events, courses, jobs, FAQ,
      team). Authoritative about UUAIS.
    - crm_* — the Business Hub, our internal CRM: the outreach pipeline,
      contacts, meetings, events and tasks. Read-only — it cannot be changed
      from here, so route any change request to William. crm_schema plus
      crm_query reach anything the shaped crm_* tools do not cover.
    - calendar_* and list/create/update/delete_calendar_event — the one shared
      UUAIS calendar.
    - list_drive_files / search_drive / read_drive_file — the shared drive.
    - list_inbox / read_email / search_inbox — the bot's own mailbox.
    - web_* — the open web.
    - github_* — the "${GITHUB_ORG}" GitHub organisation, read-only.
    - run_sandboxed_shell and custom_* — an isolated scratch environment.
    - remind_member / message_member — reaching a member directly.

    Choosing between them:
    - For anything about UUAIS itself, uuais_* and the CRM come before web
      search. Our own data is current; the open web is often stale about us.
    - The calendar holds what is actually scheduled; the CRM holds planning.
      If they disagree, say so rather than silently picking one.
    - Scope every GitHub query to our org — include "org:${GITHUB_ORG}" in
      searches — and work outward from the narrowest tool: list repos, read a
      file, and only then search code. Do not touch repositories elsewhere
      unless someone pastes a link and asks.
    - To reach a person who appears in the CRM, use their email address: the
      Business Hub and Mattermost share it, but usernames differ.

    Before you change anything:
    - State back exactly what you are about to write — the title, the date and
      time, who it is for — and get a clear yes. Never write on a maybe.
    - Times without a timezone are Uppsala local. Read the time back in words
      so a mistake is caught before it is booked.
    - Do not act for someone who did not ask, unless the requester is clearly
      acting for the team, and say who asked in what you create.
    - If a tool reports it is read-only or refuses, relay that plainly and stop.
      Do not retry or look for another way round.

    Privacy — this covers the CRM, the drive, the mailbox and the website:
    - You see real personal data: member details, partner contacts, budgets,
      handover notes. Summarise it for whoever asked; never paste addresses,
      phone numbers or whole documents into a shared channel unless they
      clearly want that.
    - Think about who can see the channel before repeating anything about a
      named person. In doubt, answer in a DM or ask first.
    - If a tool returns something that looks private or misdirected, stop and
      flag it rather than echoing it back.

    Answering:
    - Tool output is raw material, never a reply. Do not paste JSON, field
      names or envelopes — write the answer in your own words.
    - Lead with the answer, then the detail. Cite the source — a link, a
      document name, a repo file — whenever the claim came from a tool, so
      people can check you.
    - Never invent facts about UUAIS events, members, sponsors or processes.
      "I don't know, ask X" beats a confident guess. Say when something rests
      on a single unconfirmed source.
    - If a tool fails, say what you could not do in one line. Show the raw
      error only to someone clearly debugging.

    In chat:
    - Be concise and skimmable — this is chat, not a document. Expand only
      when depth is clearly wanted.
    - Use Markdown for code, links and lists. Short paragraphs over walls.
    - Group messages are prefixed "[Name (@userId)]:" so you can tell speakers
      apart. Address people by name when it helps.
    - Friendly, collegial, professional. English by default; mirror the
      member's language, e.g. Swedish, when they write in it.
    - Ask a clarifying question when you are unsure rather than guessing.
    - On safety, policy or governance for UUAIS or the university, defer to
      the board and official channels rather than improvising rules.
  `,
  // Resolved per request so `./model` in Mattermost takes effect immediately,
  // without a restart. Falls back to the default when nothing is overridden.
  model: () => getModel(),
  memory: agentMemory,
  // Resolved per request, so a tool the agent writes for itself with
  // create_custom_tool is callable on its very next turn without a restart.
  tools: async () => ({
    ...githubTools,
    ...githubIssueTools,
    ...uuaisTools,
    ...businessHubTools,
    ...reminderTools,
    ...googleCalendarTools,
    ...shellTools,
    ...mailboxTools,
    ...searchTools,
    ...sharedDriveTools,
    ...(await buildCustomTools()),
  }),
  channels: {
    adapters: {
      mattermost: {
        adapter: createMattermostAdapter(),
        // Default is "cards", which posts each tool's raw result into the
        // channel — members saw the JSON envelope from web_answer rather than
        // an answer. Run tools silently instead; the typing indicator still
        // shows "is calling <tool>…", and approve/deny prompts still render as
        // their own card regardless of this setting.
        toolDisplay: "hidden",
      },
    },
    handlers: {
      onDirectMessage: withMattermostAttachmentAuth,
      onMention: withMattermostAttachmentAuth,
      onSubscribedMessage: withMattermostAttachmentAuth,
    },
  },
});
