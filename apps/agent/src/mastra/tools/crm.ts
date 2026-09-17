// UUAIS Business Hub (CRM) tools, over the read-only Supabase Data API.
//
// Two layers on purpose. The eight shaped tools cover what members actually
// ask — the pipeline, who a contact is, what is coming up, who owns a task —
// and keep their schemas small. `crm_query` is the escape hatch for everything
// else, backed by `crm_schema` so the model can look up tables and columns
// instead of guessing at them. Nothing here can write: the account is `viewer`
// and only GET is implemented.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  MAX_ROWS,
  assigneeNames,
  compactAll,
  crmConfigured,
  daysFromToday,
  findProfile,
  profiles,
  query,
  today,
  wildcard,
} from "../crm/client";
import { TABLES, TABLE_NAMES, type TableName, columnsOf, embedsOf, isTable } from "../crm/schema";

function requireCrm(): void {
  if (!crmConfigured()) {
    throw new Error("The Business Hub CRM is not configured (CRM_SUPABASE_PUBLISHABLE_KEY, CRM_PASSWORD).");
  }
}

const limitParam = z.number().int().min(1).max(MAX_ROWS).optional().describe("Default 25");

/** Add `key=predicate` only when the caller supplied a value. */
function filter(into: Record<string, string>, key: string, predicate: string | undefined): void {
  if (predicate !== undefined) into[key] = predicate;
}

const eq = (v: unknown) => (v === undefined ? undefined : `eq.${v}`);

/** Swap each row's `assignees` uuid[] for names. */
async function withAssignees(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  return Promise.all(
    rows.map(async (row) => {
      if (!("assignees" in row)) return row;
      const { assignees, ...rest } = row;
      const names = await assigneeNames(assignees);
      return names ? { ...rest, assignees: names } : rest;
    }),
  );
}

async function run(spec: Parameters<typeof query>[0], resolveAssignees = true) {
  const page = await query(spec);
  const rows = resolveAssignees ? await withAssignees(page.rows) : page.rows;
  return {
    count: rows.length,
    ...(page.truncated ? { truncated: `Showing the first ${rows.length}; narrow the filters for more.` } : {}),
    rows: compactAll(rows),
  };
}

// --- Shaped tools ---------------------------------------------------------

export const crmPipeline = createTool({
  id: "crm_pipeline",
  description:
    "Companies in the outreach pipeline: stage, industry, who owns them, when " +
    "they were last contacted. The first stop for partnership and sponsor questions.",
  inputSchema: z.object({
    status: z
      .enum(["Contacted", "Discussing", "Negotiating", "Booked", "On hold", "Declined"])
      .optional()
      .describe("Pipeline stage"),
    industry: z.enum(["VC", "Finance", "Quant finance", "Consulting", "Tech", "Legal", "Other"]).optional(),
    name: z.string().optional().describe("Partial company name, case-insensitive"),
    established_partner: z.boolean().optional(),
    meeting_booked: z.boolean().optional(),
    stale_days: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Only companies never contacted, or not contacted in this many days"),
    with_contacts: z.boolean().optional().describe("Nest each company's people in the result"),
    limit: limitParam,
  }),
  execute: async (input) => {
    requireCrm();
    const filters: Record<string, string> = {};
    filter(filters, "status", eq(input.status));
    filter(filters, "industry", eq(input.industry));
    filter(filters, "established_partner", eq(input.established_partner));
    filter(filters, "meeting_booked", eq(input.meeting_booked));
    if (input.name) filters.name = `ilike.${wildcard(input.name)}`;
    if (input.stale_days) {
      const cutoff = daysFromToday(-input.stale_days);
      filters.or = `(last_contact_date.is.null,last_contact_date.lt.${cutoff})`;
    }

    const select = [
      "name,status,industry,contact_person,contact_title,contact_email,contact_phone",
      "last_contact_date,meeting_booked,meeting_date,established_partner,assignees,notes",
      input.with_contacts ? "contacts(name,role,email)" : "",
    ]
      .filter(Boolean)
      .join(",");

    return run({ table: "companies", select, filters, order: "name", limit: input.limit });
  },
});

export const crmContacts = createTool({
  id: "crm_contacts",
  description:
    "People at partner and prospect companies, with the company they belong to. " +
    "Use to find who to talk to, or to identify a name someone mentions.",
  inputSchema: z.object({
    name: z.string().optional().describe("Partial person name"),
    company: z.string().optional().describe("Partial company name"),
    email: z.string().optional().describe("Partial email address"),
    limit: limitParam,
  }),
  execute: async ({ name, company, email, limit }) => {
    requireCrm();
    const base: Record<string, string> = {};
    if (name) base.name = `ilike.${wildcard(name)}`;
    if (email) base.email = `ilike.${wildcard(email)}`;

    const select = "name,role,email,phone,company_name,notes,companies(name,status)";
    if (!company) return run({ table: "contacts", select, filters: base, order: "name", limit });

    // A contact's company is recorded twice: `company_name` as free text and
    // `company_id` as the real link, and either may be the populated one.
    // PostgREST cannot put an embedded column inside a top-level `or`, so ask
    // for both spellings and merge.
    const term = wildcard(company);
    const [linked, freeText] = await Promise.all([
      query({
        table: "contacts",
        select: select.replace("companies(", "companies!inner("),
        filters: { ...base, "companies.name": `ilike.${term}` },
        order: "name",
        limit,
      }),
      query({
        table: "contacts",
        select,
        filters: { ...base, company_name: `ilike.${term}` },
        order: "name",
        limit,
      }),
    ]);

    const seen = new Set<string>();
    const rows = [...linked.rows, ...freeText.rows].filter((row) => {
      const key = `${row.name}|${row.email}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { count: rows.length, rows: compactAll(rows) };
  },
});

export const crmMeetings = createTool({
  id: "crm_meetings",
  description:
    "Meetings in the Business Hub, with the company resolved. Defaults to " +
    "upcoming ones. Note this is the CRM's planning view, not the shared " +
    "Google Calendar — say so if the two disagree.",
  inputSchema: z.object({
    past: z.boolean().optional().describe("Return meetings before today instead of upcoming ones"),
    // Documented on `company` because that is where the default changes.
    from: z.string().optional().describe("ISO date, inclusive lower bound (overrides `past`)"),
    to: z.string().optional().describe("ISO date, inclusive upper bound"),
    internal: z.boolean().optional().describe("true = internal only, false = with a company only"),
    company: z
      .string()
      .optional()
      .describe("Partial company name. Searches all dates, not just upcoming ones."),
    limit: limitParam,
  }),
  execute: async ({ past, from, to, internal, company, limit }) => {
    requireCrm();
    const filters: Record<string, string> = {};
    if (from) filters.meeting_date = `gte.${from}`;
    else if (past) filters.meeting_date = `lt.${today()}`;
    // Narrowing to a company is a question about that company, not about a
    // period — defaulting to "upcoming" there would hide every past meeting
    // and answer "none" to "when did we meet Antler?".
    else if (!company) filters.meeting_date = `gte.${today()}`;
    if (to) filters.and = `(meeting_date.lte.${to})`;
    filter(filters, "internal", eq(internal));
    if (company) filters["companies.name"] = `ilike.${wildcard(company)}`;

    return run({
      table: "meetings",
      select: `title,meeting_date,meeting_time,internal,assignees,notes,companies${company ? "!inner" : ""}(name,status)`,
      filters,
      order: past || (company && !from) ? "meeting_date.desc" : "meeting_date.asc",
      limit,
    });
  },
});

export const crmEvents = createTool({
  id: "crm_events",
  description:
    "Lunch lectures and larger events, including the budget lines (cost to us, " +
    "partner revenue, food) and attendance. Treat the money as internal.",
  inputSchema: z.object({
    status: z.enum(["Planned", "Confirmed", "On hold", "Completed", "Cancelled"]).optional(),
    event_type: z.enum(["Lunch lecture", "Evening event", "Weekend event or longer", "Other"]).optional(),
    from: z.string().optional().describe("ISO date, inclusive lower bound. Omit for all dates."),
    to: z.string().optional().describe("ISO date, inclusive upper bound"),
    limit: limitParam,
  }),
  execute: async ({ status, event_type, from, to, limit }) => {
    requireCrm();
    const filters: Record<string, string> = {};
    filter(filters, "status", eq(status));
    filter(filters, "event_type", eq(event_type));
    if (from) filters.date = `gte.${from}`;
    if (to) filters.and = `(date.lte.${to})`;
    return run({
      table: "events",
      select:
        "title,event_type,status,date,duration,venue,cost_to_us,revenue_from_partner," +
        "food_cost,participant_count,luma_link,assignees,companies(name)",
      filters,
      order: "date.desc",
      limit,
    });
  },
});

export const crmTasks = createTool({
  id: "crm_tasks",
  description:
    "Team tasks, with the company or event they hang off. Tasks flagged " +
    "`personal` are hidden from this account by the database, so a count here " +
    "is a floor, not the team's true total — say so when the number matters.",
  inputSchema: z.object({
    status: z.enum(["To do", "In progress", "Done"]).optional(),
    priority: z.enum(["Low", "Medium", "High"]).optional(),
    due_before: z.string().optional().describe("ISO date"),
    overdue: z.boolean().optional().describe("Only unfinished tasks whose due date has passed"),
    assignee: z.string().optional().describe("Team member name or email"),
    limit: limitParam,
  }),
  execute: async ({ status, priority, due_before, overdue, assignee, limit }) => {
    requireCrm();
    const filters: Record<string, string> = {};
    filter(filters, "status", eq(status));
    filter(filters, "priority", eq(priority));
    if (due_before) filters.due_date = `lt.${due_before}`;
    if (overdue && !due_before) {
      filters.due_date = `lt.${today()}`;
      filters.status = `neq.Done`;
    }
    if (assignee) {
      const profile = await findProfile(assignee);
      if (!profile) {
        const known = (await profiles()).map((p) => p.name).filter(Boolean);
        throw new Error(`No Business Hub profile matches "${assignee}". Team: ${known.join(", ")}.`);
      }
      // assignees is uuid[]; `cs` is PostgREST's array-contains.
      filters.assignees = `cs.{${profile.id}}`;
    }
    return run({
      table: "tasks",
      select:
        "title,description,status,priority,due_date,personal,assignees," +
        "companies(name),events(title,date)",
      filters,
      order: "due_date.nullslast",
      limit,
    });
  },
});

export const crmTeam = createTool({
  id: "crm_team",
  description:
    "Everyone with a Business Hub account, with their role there (admin / " +
    "member / viewer). Email is the join key to Mattermost — usernames differ.",
  inputSchema: z.object({
    name: z.string().optional().describe("Partial name or email"),
  }),
  execute: async ({ name }) => {
    requireCrm();
    const [people, roles] = await Promise.all([
      profiles(),
      query({ table: "user_roles", select: "user_id,role", limit: MAX_ROWS }),
    ]);
    const roleById = new Map(roles.rows.map((r) => [String(r.user_id), r.role]));
    const needle = name?.trim().toLowerCase();
    const members = people
      .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle))
      .map((p) => ({ name: p.name, email: p.email, role: roleById.get(p.id) ?? null }));
    return { count: members.length, members: compactAll(members as unknown as Record<string, unknown>[]) };
  },
});

export const crmUpcoming = createTool({
  id: "crm_upcoming",
  description:
    "One digest of everything the Business Hub has coming up in the next N " +
    "days — meetings, events and unfinished tasks due. Use this for \"what's " +
    "happening this week\" instead of three separate calls.",
  inputSchema: z.object({
    days: z.number().int().min(1).max(365).optional().describe("Default 14"),
  }),
  execute: async ({ days }) => {
    requireCrm();
    const window = days ?? 14;
    const from = today();
    const to = daysFromToday(window);

    const [meetings, events, tasks] = await Promise.all([
      query({
        table: "meetings",
        select: "title,meeting_date,meeting_time,internal,assignees,companies(name)",
        filters: { meeting_date: `gte.${from}`, and: `(meeting_date.lte.${to})` },
        order: "meeting_date.asc",
        limit: 50,
      }),
      query({
        table: "events",
        select: "title,event_type,status,date,venue,participant_count,companies(name)",
        filters: { date: `gte.${from}`, and: `(date.lte.${to})` },
        order: "date.asc",
        limit: 50,
      }),
      query({
        table: "tasks",
        select: "title,status,priority,due_date,assignees,companies(name)",
        filters: { due_date: `gte.${from}`, and: `(due_date.lte.${to})`, status: "neq.Done" },
        order: "due_date.asc",
        limit: 50,
      }),
    ]);

    return {
      window: { from, to, days: window },
      meetings: compactAll(await withAssignees(meetings.rows)),
      events: compactAll(await withAssignees(events.rows)),
      tasks: compactAll(await withAssignees(tasks.rows)),
      note: "Personal tasks are hidden from this account, so the task list may be incomplete.",
    };
  },
});

export const crmSearch = createTool({
  id: "crm_search",
  description:
    "Free-text search across the Business Hub — companies, contacts, tasks, " +
    "events, the idea board and the internal handbook. Use when you do not " +
    "know which module a name or phrase lives in; prefer the specific tool " +
    "when you do.",
  inputSchema: z.object({
    term: z.string().min(2).describe("Name, phrase or keyword"),
    limit: z.number().int().min(1).max(25).optional().describe("Per module. Default 5."),
  }),
  execute: async ({ term, limit }) => {
    requireCrm();
    const like = wildcard(term);
    const per = limit ?? 5;

    const modules: { key: string; table: TableName; select: string; or: string }[] = [
      {
        key: "companies",
        table: "companies",
        select: "name,status,industry,contact_person,contact_email,last_contact_date,notes",
        or: `(name.ilike.${like},contact_person.ilike.${like},contact_email.ilike.${like},notes.ilike.${like})`,
      },
      {
        key: "contacts",
        table: "contacts",
        select: "name,role,email,company_name,notes,companies(name)",
        or: `(name.ilike.${like},email.ilike.${like},company_name.ilike.${like},notes.ilike.${like})`,
      },
      {
        key: "tasks",
        table: "tasks",
        select: "title,description,status,priority,due_date",
        or: `(title.ilike.${like},description.ilike.${like})`,
      },
      {
        key: "events",
        table: "events",
        select: "title,event_type,status,date,venue",
        or: `(title.ilike.${like},venue.ilike.${like})`,
      },
      {
        key: "board_posts",
        table: "board_posts",
        select: "category,content",
        or: `(category.ilike.${like},content.ilike.${like})`,
      },
      {
        key: "handbook",
        table: "info_sections",
        select: "title,body,sort_order",
        or: `(title.ilike.${like},body.ilike.${like})`,
      },
    ];

    // Handbook sections and long notes are full markdown; a six-module search
    // that returned all of it whole would swamp the context window.
    const excerpt = (rows: Record<string, unknown>[]) =>
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            k,
            typeof v === "string" && v.length > 400 ? `${v.slice(0, 400)}…` : v,
          ]),
        ),
      );

    const settled = await Promise.allSettled(
      modules.map((m) => query({ table: m.table, select: m.select, filters: { or: m.or }, limit: per })),
    );

    const results: Record<string, unknown> = {};
    const failed: string[] = [];
    settled.forEach((outcome, i) => {
      const key = modules[i]!.key;
      // One module failing should not lose the other five.
      if (outcome.status === "rejected") failed.push(key);
      else if (outcome.value.rows.length) results[key] = excerpt(compactAll(outcome.value.rows));
    });

    return {
      term,
      matches: Object.keys(results).length ? results : null,
      ...(failed.length ? { unsearched: failed } : {}),
      ...(Object.keys(results).length ? {} : { note: "Nothing matched in any module." }),
    };
  },
});

// --- Generic layer --------------------------------------------------------

export const crmQuery = createTool({
  id: "crm_query",
  description:
    "Read any Business Hub table directly (PostgREST syntax) when the shaped " +
    "crm_* tools cannot express what you need — an unusual filter, a column " +
    "they omit, a table they do not cover, or an exact count. Call crm_schema " +
    "first for table and column names. Read-only.",
  inputSchema: z.object({
    table: z.enum(TABLE_NAMES as [TableName, ...TableName[]]),
    select: z
      .string()
      .optional()
      .describe(
        'Columns, comma-separated. Embed a related table as "contacts(name,role)", ' +
          'or "contacts!inner(name)" to drop parents with no children. Default: all columns.',
      ),
    filters: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Column -> predicate, e.g. {"status":"eq.Booked","last_contact_date":"is.null"}. ' +
          "Operators: eq, neq, gt, gte, lt, lte, like, ilike (use * as wildcard), in.(a,b), " +
          'is.null, not.is.null, cs.{uuid} for uuid[] columns. Use the key "or" with ' +
          '"(a.is.null,b.lt.2026-08-18)" for alternatives.',
      ),
    order: z.string().optional().describe('e.g. "date.desc" or "due_date.nullslast"'),
    limit: limitParam,
    offset: z.number().int().min(0).optional().describe("For paging"),
    count: z
      .boolean()
      .optional()
      .describe("Return the exact number of matching rows instead of the rows themselves"),
  }),
  execute: async ({ table, select, filters, order, limit, offset, count }) => {
    requireCrm();
    if (!isTable(table)) throw new Error(`Unknown table "${table}". Call crm_schema for the list.`);
    if (count) {
      const page = await query({ table, select: select ?? "id", filters, count: true });
      return { table, filters: filters ?? {}, total: page.total };
    }
    return run({ table, select, filters, order, limit, offset });
  },
});

export const crmSchema = createTool({
  id: "crm_schema",
  description:
    "The Business Hub's data model — tables, columns, enum values, foreign " +
    "keys and what can be embedded. Call before crm_query when unsure of a " +
    "name. Pass a table for its detail, or nothing for the overview.",
  inputSchema: z.object({
    table: z.string().optional().describe("One table name; omit for the list of all 17"),
  }),
  execute: async ({ table }) => {
    if (table) {
      if (!isTable(table)) {
        throw new Error(`Unknown table "${table}". Tables: ${TABLE_NAMES.join(", ")}.`);
      }
      const spec = TABLES[table];
      return {
        table,
        summary: spec.summary,
        approx_rows: spec.rows,
        columns: spec.columns,
        ...("enums" in spec ? { enums: spec.enums } : {}),
        ...("fks" in spec ? { foreign_keys: spec.fks } : {}),
        ...("arrayRefs" in spec
          ? { not_embeddable: `${spec.arrayRefs.join(", ")} — uuid[] with no FK; resolve against profiles` }
          : {}),
        ...("visibility" in spec ? { visibility: spec.visibility } : {}),
        embeddable: embedsOf(table),
        example: `crm_query({ table: "${table}", select: "${columnsOf(table).slice(0, 3).join(",")}", limit: 10 })`,
      };
    }

    const overview: Record<string, string[]> = {};
    for (const name of TABLE_NAMES) {
      const spec = TABLES[name];
      (overview[spec.group] ??= []).push(`${name} (~${spec.rows} rows) — ${spec.summary}`);
    }
    return {
      source: "UUAIS Business Hub, read-only Supabase Data API. Verified 17 Sep 2026.",
      tables: overview,
      caveats: [
        "Read-only: writes are refused by the database. Ask William if something must change.",
        "Tasks flagged `personal` are hidden from this account; notifications and user_visits always read empty.",
        "Row counts are indicative, from the schema handover — use crm_query with count for a live total.",
      ],
      next: "Call crm_schema with a table name for its columns, enums and embeds.",
    };
  },
});

export const crmTools = {
  crm_pipeline: crmPipeline,
  crm_contacts: crmContacts,
  crm_meetings: crmMeetings,
  crm_events: crmEvents,
  crm_tasks: crmTasks,
  crm_team: crmTeam,
  crm_upcoming: crmUpcoming,
  crm_search: crmSearch,
  crm_query: crmQuery,
  crm_schema: crmSchema,
};
