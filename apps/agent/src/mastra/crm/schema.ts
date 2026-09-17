// The Business Hub's data model, transcribed from the read-only API handover
// verified against the live database on 17 Sep 2026.
//
// It lives here rather than in a tool description because the agent needs it to
// build queries but should not pay for it on every turn: `crm_schema` hands it
// over only when the model actually goes off the purpose-built tools.

export type TableSpec = {
  group: string;
  /** Row count as of 17 Sep 2026 — indicative, not a guarantee. */
  rows: number;
  summary: string;
  /** column -> human-readable type. */
  columns: Record<string, string>;
  /** column -> allowed values, for enum columns. */
  enums?: Record<string, string[]>;
  /** column -> "table.column". Embeddable unless listed in `arrayRefs`. */
  fks?: Record<string, string>;
  /**
   * Columns holding uuid[] that point at another table. Postgres has no FK
   * constraint behind them, so PostgREST cannot embed through them — resolve
   * the ids against `profiles` yourself.
   */
  arrayRefs?: string[];
  /** Rows this account cannot see, and why. */
  visibility?: string;
};

export const TABLES = {
  companies: {
    group: "Pipeline & delivery",
    rows: 92,
    summary: "The outreach pipeline. One row per company; `status` is the stage.",
    columns: {
      id: "uuid · PK",
      name: "text",
      status: "enum",
      industry: "enum · nullable",
      contact_person: "text",
      contact_title: "text",
      contact_email: "text",
      contact_phone: "text",
      last_contact_date: "date",
      meeting_booked: "bool",
      meeting_date: "date",
      established_partner: "bool",
      assignees: "uuid[]",
      notes: "text",
    },
    enums: {
      status: ["Contacted", "Discussing", "Negotiating", "Booked", "On hold", "Declined"],
      industry: ["VC", "Finance", "Quant finance", "Consulting", "Tech", "Legal", "Other"],
    },
    fks: { assignees: "profiles.id" },
    arrayRefs: ["assignees"],
  },
  contacts: {
    group: "Pipeline & delivery",
    rows: 14,
    summary: "People at those companies. Not every company has one.",
    columns: {
      id: "uuid · PK",
      name: "text",
      role: "text · job title",
      email: "text",
      phone: "text",
      company_id: "uuid",
      company_name: "text · free text",
      notes: "text",
    },
    fks: { company_id: "companies.id" },
  },
  meetings: {
    group: "Pipeline & delivery",
    rows: 14,
    summary: "Internal and external meetings. `internal` true means no company attached.",
    columns: {
      id: "uuid · PK",
      title: "text",
      company_id: "uuid",
      meeting_date: "date",
      meeting_time: "time · nullable",
      internal: "bool",
      assignees: "uuid[]",
      notes: "text",
    },
    fks: { company_id: "companies.id", assignees: "profiles.id" },
    arrayRefs: ["assignees"],
  },
  events: {
    group: "Pipeline & delivery",
    rows: 6,
    summary: "Lunch lectures and larger events, with the money attached.",
    columns: {
      id: "uuid · PK",
      title: "text",
      company_id: "uuid",
      event_type: "enum",
      status: "enum",
      date: "date",
      duration: "text",
      venue: "text",
      cost_to_us: "numeric",
      revenue_from_partner: "numeric",
      food_cost: "numeric",
      participant_count: "int",
      luma_link: "text",
      assignees: "uuid[]",
    },
    enums: {
      status: ["Planned", "Confirmed", "On hold", "Completed", "Cancelled"],
      event_type: ["Lunch lecture", "Evening event", "Weekend event or longer", "Other"],
    },
    fks: { company_id: "companies.id", assignees: "profiles.id" },
    arrayRefs: ["assignees"],
  },
  tasks: {
    group: "Pipeline & delivery",
    rows: 28,
    summary: "Team tasks.",
    columns: {
      id: "uuid · PK",
      title: "text",
      description: "text",
      status: "enum",
      priority: "enum",
      due_date: "date",
      personal: "bool",
      related_company_id: "uuid",
      related_event_id: "uuid",
      assignees: "uuid[]",
    },
    enums: {
      status: ["To do", "In progress", "Done"],
      priority: ["Low", "Medium", "High"],
    },
    fks: {
      related_company_id: "companies.id",
      related_event_id: "events.id",
      assignees: "profiles.id",
    },
    arrayRefs: ["assignees"],
    visibility:
      "Tasks flagged `personal` are readable only by the people assigned to them, so " +
      "counts from this account are lower than what the team sees.",
  },
  contracts: {
    group: "Pipeline & delivery",
    rows: 0,
    summary: "Generated partnership contracts. Empty today. `company_name` is free text, not a foreign key.",
    columns: {
      id: "uuid · PK",
      company_name: "text · no FK",
      event_type: "enum",
      price: "numeric",
      language: "text",
      custom_terms: "text",
      content_snapshot: "text",
      generated_by: "uuid",
      date_generated: "timestamptz",
    },
    fks: { generated_by: "profiles.id" },
  },
  contract_templates: {
    group: "Pipeline & delivery",
    rows: 2,
    summary: "Contract boilerplate and price list, keyed by language.",
    columns: { language: "text · PK", template: "text · markdown", pricing: "jsonb" },
  },
  board_posts: {
    group: "Collaboration",
    rows: 28,
    summary: "The idea board. One row per idea.",
    columns: { id: "uuid · PK", category: "text", content: "text", author_id: "uuid" },
    fks: { author_id: "profiles.id" },
  },
  idea_comments: {
    group: "Collaboration",
    rows: 5,
    summary: "Threaded replies on ideas.",
    columns: { id: "uuid · PK", post_id: "uuid", author_id: "uuid", content: "text" },
    fks: { post_id: "board_posts.id", author_id: "profiles.id" },
  },
  idea_likes: {
    group: "Collaboration",
    rows: 13,
    summary: "One row per like. Composite primary key.",
    columns: { post_id: "uuid · PK", user_id: "uuid · PK" },
    fks: { post_id: "board_posts.id", user_id: "profiles.id" },
  },
  chat_messages: {
    group: "Collaboration",
    rows: 1,
    summary: "In-app team chat. Barely used.",
    columns: { id: "uuid · PK", author_id: "uuid", content: "text" },
    fks: { author_id: "profiles.id" },
  },
  info_sections: {
    group: "Collaboration",
    rows: 6,
    summary: "The internal handbook, rendered as markdown in the app.",
    columns: { id: "uuid · PK", title: "text", body: "text · markdown", sort_order: "int" },
  },
  profiles: {
    group: "People & system",
    rows: 13,
    summary: "Team members. Every `assignees` array points here.",
    columns: { id: "uuid · PK", name: "text", email: "text", avatar_url: "text" },
  },
  user_roles: {
    group: "People & system",
    rows: 13,
    summary: "Who may do what. This account is `viewer`.",
    columns: { id: "uuid · PK", user_id: "uuid", role: "enum" },
    enums: { role: ["admin", "member", "viewer"] },
  },
  notifications: {
    group: "People & system",
    rows: 0,
    summary: "Scoped to the signed-in user.",
    columns: { id: "uuid · PK", user_id: "uuid", title: "text", body: "text", read: "bool" },
    fks: { user_id: "profiles.id" },
    visibility: "Scoped to the signed-in user, who has none — always reads empty.",
  },
  user_visits: {
    group: "People & system",
    rows: 0,
    summary: "Per-user visit counter.",
    columns: { user_id: "uuid · PK", visit_count: "int", last_visit_at: "timestamptz" },
    fks: { user_id: "profiles.id" },
    visibility: "Scoped to the signed-in user — always reads empty.",
  },
  access_requests: {
    group: "People & system",
    rows: 0,
    summary: "Pending sign-ups awaiting approval. Currently empty.",
    columns: { id: "uuid · PK", name: "text", email: "text", message: "text", status: "text" },
  },
} as const satisfies Record<string, TableSpec>;

export type TableName = keyof typeof TABLES;

export const TABLE_NAMES = Object.keys(TABLES) as TableName[];

export function isTable(name: string): name is TableName {
  return Object.hasOwn(TABLES, name);
}

/** Columns of `table`, for validating a caller-supplied filter or sort key. */
export function columnsOf(table: TableName): string[] {
  return Object.keys(TABLES[table].columns);
}

/**
 * Tables that can be embedded from `table` in a single `select`, derived from
 * the declared foreign keys so it cannot drift from the column list. Array
 * references are excluded: there is no FK constraint for PostgREST to follow.
 */
export function embedsOf(table: TableName): string[] {
  const spec = TABLES[table] as TableSpec;
  const arrays = new Set(spec.arrayRefs ?? []);
  const parents = Object.entries(spec.fks ?? {})
    .filter(([column]) => !arrays.has(column))
    .map(([, target]) => target.split(".")[0]!);

  const children = TABLE_NAMES.filter((other) => {
    const otherSpec = TABLES[other] as TableSpec;
    const otherArrays = new Set(otherSpec.arrayRefs ?? []);
    return Object.entries(otherSpec.fks ?? {}).some(
      ([column, target]) => !otherArrays.has(column) && target.split(".")[0] === table,
    );
  });

  return [...new Set([...parents, ...children])].sort();
}
