import { createClient, type Client } from "@libsql/client";

export type Preference = { enabled: boolean; weekly: boolean };
export type Assignment = {
  taskId: string;
  profileId: string;
  email: string;
  name: string;
  title: string;
  description: string;
  dueDate: string;
};

export class CrmReminderStore {
  private ready: Promise<void> | null = null;
  constructor(
    private readonly client: Client = createClient({
      url: process.env.DATABASE_URL ?? "file:./mastra.db",
    }),
  ) {}
  private init() {
    return (this.ready ??= (async () => {
      await this.client.execute(
        `CREATE TABLE IF NOT EXISTS crm_reminder_prefs (user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, weekly INTEGER NOT NULL DEFAULT 0)`,
      );
      await this.client.execute(
        `CREATE TABLE IF NOT EXISTS crm_assignment_state (task_id TEXT NOT NULL, user_id TEXT NOT NULL, fingerprint TEXT NOT NULL, active INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(task_id,user_id))`,
      );
      await this.client.execute(
        `CREATE TABLE IF NOT EXISTS crm_reminder_posts (post_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, user_id TEXT NOT NULL, task_id TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL)`,
      );
      await this.client.execute(
        `CREATE INDEX IF NOT EXISTS crm_reminder_context ON crm_reminder_posts(channel_id,user_id,created_at)`,
      );
      await this.client.execute(
        `CREATE TABLE IF NOT EXISTS crm_weekly_sent (user_id TEXT NOT NULL, week TEXT NOT NULL, PRIMARY KEY(user_id,week))`,
      );
      await this.client.execute(
        `CREATE TABLE IF NOT EXISTS crm_reminder_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      );
    })().catch((error) => {
      this.ready = null;
      throw error;
    }));
  }
  async preference(userId: string): Promise<Preference> {
    await this.init();
    const r = await this.client.execute({
      sql: "SELECT enabled,weekly FROM crm_reminder_prefs WHERE user_id=?",
      args: [userId],
    });
    const row = r.rows[0];
    return row
      ? { enabled: Number(row.enabled) === 1, weekly: Number(row.weekly) === 1 }
      : { enabled: true, weekly: false };
  }
  async setPreference(userId: string, pref: Preference) {
    await this.init();
    await this.client.execute({
      sql: `INSERT INTO crm_reminder_prefs(user_id,enabled,weekly) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,weekly=excluded.weekly`,
      args: [userId, +pref.enabled, +pref.weekly],
    });
  }
  async reconcile(assignments: Assignment[]): Promise<Assignment[]> {
    await this.init();
    const tx = await this.client.transaction("write");
    try {
      const prior = await tx.execute(
        "SELECT task_id,user_id,fingerprint,active FROM crm_assignment_state",
      );
      const old = new Map(
        prior.rows.map((r) => [
          `${r.task_id}:${r.user_id}`,
          {
            fingerprint: String(r.fingerprint),
            active: Number(r.active) === 1,
          },
        ]),
      );
      const seeded = await tx.execute(
        "SELECT value FROM crm_reminder_meta WHERE key='baseline'",
      );
      if (!seeded.rows.length) {
        for (const a of assignments)
          await tx.execute({
            sql: "INSERT INTO crm_assignment_state(task_id,user_id,fingerprint,active,delivered) VALUES(?,?,?,1,1)",
            args: [a.taskId, a.profileId, fingerprint(a)],
          });
        await tx.execute(
          "INSERT INTO crm_reminder_meta VALUES('baseline','1')",
        );
        await tx.commit();
        return [];
      }
      const current = new Set(
        assignments.map((a) => `${a.taskId}:${a.profileId}`),
      );
      for (const [key, v] of old)
        if (v.active && !current.has(key)) {
          const [taskId, userId] = key.split(":");
          await tx.execute({
            sql: "UPDATE crm_assignment_state SET active=0 WHERE task_id=? AND user_id=?",
            args: [taskId, userId],
          });
        }
      const added: Assignment[] = [];
      for (const a of assignments) {
        const key = `${a.taskId}:${a.profileId}`,
          fp = fingerprint(a),
          prev = old.get(key);
        const changed = !prev || !prev.active;
        if (changed) added.push(a);
        await tx.execute({
          sql: `INSERT INTO crm_assignment_state(task_id,user_id,fingerprint,active,delivered) VALUES(?,?,?,1,0) ON CONFLICT(task_id,user_id) DO UPDATE SET fingerprint=excluded.fingerprint,active=1,delivered=CASE WHEN ? THEN 0 ELSE crm_assignment_state.delivered END`,
          args: [a.taskId, a.profileId, fp, +changed],
        });
      }
      const pending = await tx.execute(
        "SELECT task_id,user_id FROM crm_assignment_state WHERE active=1 AND delivered=0",
      );
      const keys = new Set(
        pending.rows.map((r) => `${r.task_id}:${r.user_id}`),
      );
      for (const a of assignments)
        if (
          keys.has(`${a.taskId}:${a.profileId}`) &&
          !added.some(
            (x) => x.taskId === a.taskId && x.profileId === a.profileId,
          )
        )
          added.push(a);
      await tx.commit();
      return added;
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }
  async markDelivered(taskId: string, profileId: string) {
    await this.init();
    await this.client.execute({
      sql: "UPDATE crm_assignment_state SET delivered=1 WHERE task_id=? AND user_id=?",
      args: [taskId, profileId],
    });
  }
  async savePost(
    postId: string,
    channelId: string,
    userId: string,
    taskId: string,
    message: string,
  ) {
    await this.init();
    await this.client.execute({
      sql: "INSERT OR REPLACE INTO crm_reminder_posts VALUES(?,?,?,?,?,?)",
      args: [postId, channelId, userId, taskId, message, Date.now()],
    });
  }
  async completeAssignmentBatch(
    post: { postId: string; channelId: string; userId: string; taskIds: string[]; message: string } | null,
    pairs: Array<{ taskId: string; profileId: string }>,
  ) {
    await this.init();
    const tx = await this.client.transaction("write");
    try {
      if (post)
        await tx.execute({
          sql: "INSERT OR REPLACE INTO crm_reminder_posts VALUES(?,?,?,?,?,?)",
          args: [post.postId, post.channelId, post.userId, JSON.stringify(post.taskIds), post.message, Date.now()],
        });
      for (const pair of pairs)
        await tx.execute({
          sql: "UPDATE crm_assignment_state SET delivered=1 WHERE task_id=? AND user_id=?",
          args: [pair.taskId, pair.profileId],
        });
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
  async context(
    channelId: string,
    rootPostId: string,
    userId: string,
  ): Promise<string | null> {
    await this.init();
    const r = await this.client.execute({
      sql: "SELECT message,created_at FROM crm_reminder_posts WHERE channel_id=? AND post_id=? AND user_id=?",
      args: [channelId, rootPostId, userId],
    });
    return r.rows[0]
      ? JSON.stringify({
          sentAt: new Date(Number(r.rows[0].created_at)).toISOString(),
          text: String(r.rows[0].message),
        })
      : null;
  }
  async latestContext(
    channelId: string,
    userId: string,
  ): Promise<string | null> {
    await this.init();
    const r = await this.client.execute({
      sql: "SELECT message,created_at FROM crm_reminder_posts WHERE channel_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1",
      args: [channelId, userId],
    });
    return r.rows[0]
      ? JSON.stringify({
          sentAt: new Date(Number(r.rows[0].created_at)).toISOString(),
          text: String(r.rows[0].message),
        })
      : null;
  }
  async wasWeeklySent(userId: string, week: string): Promise<boolean> {
    await this.init();
    const r = await this.client.execute({
      sql: "SELECT 1 FROM crm_weekly_sent WHERE user_id=? AND week=?",
      args: [userId, week],
    });
    return r.rows.length > 0;
  }
  async markWeeklySent(userId: string, week: string) {
    await this.init();
    await this.client.execute({
      sql: "INSERT OR IGNORE INTO crm_weekly_sent VALUES(?,?)",
      args: [userId, week],
    });
  }
}
function fingerprint(a: Assignment) {
  return JSON.stringify([a.title, a.description, a.dueDate]);
}
