// Shared Google service-account credentials.
//
// One place to read the key from, so Calendar and Drive cannot drift apart on
// how they load it. Scopes are requested per client rather than globally: a
// token minted for Drive cannot touch Calendar and vice versa.
import { JWT } from "google-auth-library";
import { readFileSync } from "node:fs";

export type GoogleCredentials = { clientEmail: string; privateKey: string };

export function googleCredentials(): GoogleCredentials | null {
  const inlineEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const inlineKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

  // Inline env vars first: a container has no convenient place for a key file.
  if (inlineEmail && inlineKey) {
    // Env vars flatten newlines; PEM parsing needs them back.
    return { clientEmail: inlineEmail, privateKey: inlineKey.replace(/\\n/g, "\n") };
  }

  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (!keyFile) return null;

  try {
    const parsed = JSON.parse(readFileSync(keyFile, "utf8"));
    if (!parsed.client_email || !parsed.private_key) {
      console.warn(`[google] ${keyFile} is missing client_email or private_key.`);
      return null;
    }
    return { clientEmail: parsed.client_email, privateKey: parsed.private_key };
  } catch (error) {
    console.warn(
      `[google] Could not read GOOGLE_SERVICE_ACCOUNT_KEY_FILE (${keyFile}):`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export function serviceAccountEmail(): string | null {
  return googleCredentials()?.clientEmail ?? null;
}

const clients = new Map<string, JWT>();

/** A JWT client for exactly these scopes, cached so tokens are reused. */
export function scopedJwt(scopes: string[], missingHint: string): JWT {
  const key = scopes.slice().sort().join(" ");
  const existing = clients.get(key);
  if (existing) return existing;

  const creds = googleCredentials();
  if (!creds) throw new Error(missingHint);

  const client = new JWT({ email: creds.clientEmail, key: creds.privateKey, scopes });
  clients.set(key, client);
  return client;
}
