// Durable reminder queue. Reminders outlive restarts and redeploys, so they live
// in the same LibSQL database as Mastra's own state rather than in memory —
// a reminder that evaporates when the process restarts is worse than none.
import { createClient, type Client } from "@libsql/client";

export type ReminderStatus = "pending" | "sent" | "failed" | "cancelled";

export type Reminder = {
  id: string;
  recipientRef: string;
  message: string;
  dueAt: number;
  status: ReminderStatus;
  createdBy: string | null;
  createdAt: number;
  sentAt: number | null;
  attempts: number;
  lastError: string | null;
};

let client: Client | null = null;
let ready: Promise<void> | null = null;

function db(): Client {
  if (!client) {
    client = createClient({ url: process.env.DATABASE_URL ?? "file:./mastra.db" });
  }
  return client;
}

async function init(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await db().execute(`
        CREATE TABLE IF NOT EXISTS agent_reminders (
          id TEXT PRIMARY KEY,
          recipient_ref TEXT NOT NULL,
          message TEXT NOT NULL,
          due_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_by TEXT,
          created_at INTEGER NOT NULL,
          sent_at INTEGER,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT
        )
      `);
      await db().execute(
        `CREATE INDEX IF NOT EXISTS agent_reminders_due ON agent_reminders (status, due_at)`,
      );
    })();
  }
  return ready;
}

type Row = Record<string, unknown>;

function toReminder(row: Row): Reminder {
  return {
    id: String(row.id),
    recipientRef: String(row.recipient_ref),
    message: String(row.message),
    dueAt: Number(row.due_at),
    status: String(row.status) as ReminderStatus,
    createdBy: row.created_by == null ? null : String(row.created_by),
    createdAt: Number(row.created_at),
    sentAt: row.sent_at == null ? null : Number(row.sent_at),
    attempts: Number(row.attempts ?? 0),
    lastError: row.last_error == null ? null : String(row.last_error),
  };
}

export async function createReminder(input: {
  recipientRef: string;
  message: string;
  dueAt: number;
  createdBy?: string | null;
}): Promise<Reminder> {
  await init();
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  await db().execute({
    sql: `INSERT INTO agent_reminders (id, recipient_ref, message, due_at, status, created_by, created_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    args: [id, input.recipientRef, input.message, input.dueAt, input.createdBy ?? null, createdAt],
  });
  return {
    id,
    recipientRef: input.recipientRef,
    message: input.message,
    dueAt: input.dueAt,
    status: "pending",
    createdBy: input.createdBy ?? null,
    createdAt,
    sentAt: null,
    attempts: 0,
    lastError: null,
  };
}

export async function listReminders(filter: {
  status?: ReminderStatus;
  recipientRef?: string;
  limit?: number;
}): Promise<Reminder[]> {
  await init();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  if (filter.recipientRef) {
    where.push("lower(recipient_ref) = lower(?)");
    args.push(filter.recipientRef);
  }
  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
  const result = await db().execute({
    sql: `SELECT * FROM agent_reminders ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY due_at ASC LIMIT ${limit}`,
    args,
  });
  return result.rows.map((r) => toReminder(r as Row));
}

export async function cancelReminder(id: string): Promise<boolean> {
  await init();
  const result = await db().execute({
    sql: `UPDATE agent_reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'`,
    args: [id],
  });
  return result.rowsAffected > 0;
}

/** Pending reminders whose time has come. */
export async function dueReminders(now = Date.now(), limit = 25): Promise<Reminder[]> {
  await init();
  const result = await db().execute({
    sql: `SELECT * FROM agent_reminders WHERE status = 'pending' AND due_at <= ?
          ORDER BY due_at ASC LIMIT ${limit}`,
    args: [now],
  });
  return result.rows.map((r) => toReminder(r as Row));
}

export async function markSent(id: string): Promise<void> {
  await init();
  await db().execute({
    sql: `UPDATE agent_reminders SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?`,
    args: [Date.now(), id],
  });
}

/**
 * Record a failed delivery. Gives up after `maxAttempts` so a reminder aimed at
 * a deleted account cannot be retried forever.
 */
export async function markFailed(id: string, error: string, maxAttempts = 3): Promise<void> {
  await init();
  await db().execute({
    sql: `UPDATE agent_reminders
          SET attempts = attempts + 1,
              last_error = ?,
              status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
          WHERE id = ?`,
    args: [error.slice(0, 500), maxAttempts, id],
  });
}
