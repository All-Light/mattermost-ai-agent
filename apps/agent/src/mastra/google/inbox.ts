// Read-only access to the bot's own mailbox (bot@uuais.com) over IMAP.
//
// Chosen over Gmail API + domain-wide delegation on purpose: an app password
// reaches exactly one mailbox and cannot be turned on another user, whereas DWD
// is a domain-wide trust that happens to be scoped. IMAP also cannot send mail —
// that needs SMTP, which is never opened here — so "read but do not send" is a
// property of the transport rather than a promise in a prompt.
//
// Every mailbox is opened read-only, so nothing can be marked, moved or deleted.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const HOST = process.env.GOOGLE_IMAP_HOST ?? "imap.gmail.com";
const PORT = Number(process.env.GOOGLE_IMAP_PORT ?? 993);

function credentials(): { user: string; pass: string } | null {
  // Values may be quoted in .env; dotenv keeps the quotes when they are mixed
  // with other characters, so strip them defensively.
  const user = process.env.GOOGLE_BOT_NAME?.trim().replace(/^["']|["']$/g, "");
  const pass = process.env.GOOGLE_BOT_PASSWORD?.trim().replace(/^["']|["']$/g, "");
  if (!user || !pass) return null;
  return { user, pass };
}

export function inboxConfigured(): boolean {
  return credentials() !== null;
}

export function inboxAddress(): string | null {
  return credentials()?.user ?? null;
}

async function withMailbox<T>(
  mailbox: string,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const creds = credentials();
  if (!creds) {
    throw new Error("Mailbox is not configured (GOOGLE_BOT_NAME / GOOGLE_BOT_PASSWORD).");
  }

  const client = new ImapFlow({
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
    // Without these the client retries a rejected login indefinitely, which
    // turns a wrong password into a hung tool call rather than an error the
    // agent can report.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    disableAutoIdle: true,
  });

  // Belt and braces: a stalled TLS handshake is not covered by the options above.
  const connectWithDeadline = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out connecting to the mail server.")), 25_000);
    });
    try {
      await Promise.race([client.connect(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    await connectWithDeadline();
  } catch (error) {
    // ImapFlow reports the useful part on its own fields, not in `message`
    // (which is just "Command failed"), so gather them before deciding.
    const err = error as {
      message?: string;
      authenticationFailed?: boolean;
      responseText?: string;
      serverResponseCode?: string;
    };
    const message = [err.message, err.responseText, err.serverResponseCode]
      .filter(Boolean)
      .join(" — ") || String(error);

    if (err.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials/i.test(message)) {
      throw new Error(
        `Mailbox sign-in was rejected for ${creds.user}. Gmail does not accept an ` +
          "account's normal password over IMAP — GOOGLE_BOT_PASSWORD must be a " +
          "16-character App Password, which requires 2-Step Verification on that " +
          "account. Check IMAP is enabled for the domain too.",
      );
    }
    throw new Error(`Could not reach the mailbox: ${message}`);
  }

  try {
    // Read-only: nothing here may alter the mailbox.
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export type InboxMessage = {
  uid: number;
  from: string;
  subject: string;
  date: string | null;
  seen: boolean;
  snippet: string;
};

function addressText(value: unknown): string {
  const v = value as { text?: string } | undefined;
  return v?.text ?? "(unknown)";
}

export async function listMessages(opts: {
  mailbox?: string;
  limit?: number;
  unreadOnly?: boolean;
}): Promise<InboxMessage[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  return withMailbox(opts.mailbox ?? "INBOX", async (client) => {
    const criteria = opts.unreadOnly ? { seen: false } : { all: true };
    const uids = await client.search(criteria, { uid: true });
    if (!uids || !uids.length) return [];

    const wanted = uids.slice(-limit).reverse();
    const out: InboxMessage[] = [];
    for await (const msg of client.fetch(
      { uid: wanted.join(",") },
      { uid: true, envelope: true, flags: true, bodyStructure: false },
    )) {
      const env = msg.envelope;
      out.push({
        uid: msg.uid,
        from: env?.from?.map((a) => `${a.name ? `${a.name} ` : ""}<${a.address}>`).join(", ") ?? "(unknown)",
        subject: env?.subject ?? "(no subject)",
        date: env?.date ? new Date(env.date).toISOString() : null,
        seen: msg.flags?.has("\\Seen") ?? false,
        snippet: "",
      });
    }
    // fetch() yields in mailbox order; present newest first.
    return out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  });
}

export async function readMessage(
  uid: number,
  mailbox = "INBOX",
): Promise<{ from: string; to: string; subject: string; date: string | null; body: string }> {
  return withMailbox(mailbox, async (client) => {
    const msg = await client.fetchOne(String(uid), { uid: true, source: true });
    if (!msg || !msg.source) throw new Error(`No message with uid ${uid} in ${mailbox}.`);
    const parsed = await simpleParser(msg.source);
    const body = (parsed.text ?? parsed.html ?? "").toString();
    return {
      from: addressText(parsed.from),
      to: addressText(parsed.to),
      subject: parsed.subject ?? "(no subject)",
      date: parsed.date ? parsed.date.toISOString() : null,
      // Long threads blow the context window; the model can ask for more.
      body: body.length > 20_000 ? `${body.slice(0, 20_000)}\n\n[truncated]` : body,
    };
  });
}

export async function searchMessages(
  query: string,
  opts: { mailbox?: string; limit?: number } = {},
): Promise<InboxMessage[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  return withMailbox(opts.mailbox ?? "INBOX", async (client) => {
    const uids = await client.search({ or: [{ subject: query }, { from: query }, { body: query }] }, { uid: true });
    if (!uids || !uids.length) return [];
    const out: InboxMessage[] = [];
    for await (const msg of client.fetch(
      { uid: uids.slice(-limit).join(",") },
      { uid: true, envelope: true, flags: true },
    )) {
      out.push({
        uid: msg.uid,
        from: msg.envelope?.from?.map((a) => `<${a.address}>`).join(", ") ?? "(unknown)",
        subject: msg.envelope?.subject ?? "(no subject)",
        date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
        seen: msg.flags?.has("\\Seen") ?? false,
        snippet: "",
      });
    }
    return out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  });
}
