// Read-only access to the UUAIS shared drive.
//
// Scope is drive.readonly, so Google itself refuses any write — the agent
// cannot edit, move or delete a document even if it decided to try. What it can
// see is whatever the drive has been shared with, nothing else: a service
// account owns no Drive content of its own.
import { scopedJwt, serviceAccountEmail } from "./auth";

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const API = "https://www.googleapis.com/drive/v3";

/** Google-native formats have no bytes to download; they must be exported. */
const EXPORT_AS: Record<string, { mime: string; label: string }> = {
  "application/vnd.google-apps.document": { mime: "text/plain", label: "Doc" },
  "application/vnd.google-apps.spreadsheet": { mime: "text/csv", label: "Sheet" },
  "application/vnd.google-apps.presentation": { mime: "text/plain", label: "Slides" },
};

/** Anything else is only worth returning if it is actually text. */
const READABLE_TEXT = /^(text\/|application\/(json|xml|csv|x-yaml|yaml))/;

const MAX_CHARS = 20_000;

export function driveConfigured(): boolean {
  return process.env.GOOGLE_DRIVE_ENABLED !== "false" && serviceAccountEmail() !== null;
}

function jwt() {
  return scopedJwt(
    [SCOPE],
    "Google Drive is not configured — the service-account credentials are missing.",
  );
}

async function driveFetch(path: string, init?: RequestInit): Promise<Response> {
  const { token } = await jwt().getAccessToken();
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init?.headers },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    if (response.status === 404) {
      throw new Error(
        `Not found, or not shared with the bot. The drive must be shared with ` +
          `${serviceAccountEmail()} — sharing it with bot@uuais.com does not grant the agent access.`,
      );
    }
    if (response.status === 403) {
      throw new Error(`Drive refused the request (403). ${detail}`);
    }
    throw new Error(`Drive API ${response.status}: ${detail}`);
  }
  return response;
}

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  parents?: string[];
};

const FILE_FIELDS = "files(id,name,mimeType,modifiedTime,size,webViewLink),nextPageToken";
// Shared drives are invisible without both of these flags.
const SHARED_DRIVE_PARAMS = "supportsAllDrives=true&includeItemsFromAllDrives=true";

export async function listDrives(): Promise<{ id: string; name: string }[]> {
  const response = await driveFetch("/drives?pageSize=50");
  const data = (await response.json()) as { drives?: { id: string; name: string }[] };
  return data.drives ?? [];
}

export async function listFiles(opts: {
  query?: string;
  folderId?: string;
  limit?: number;
}): Promise<DriveFile[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const clauses = ["trashed = false"];
  if (opts.folderId) clauses.push(`'${opts.folderId.replace(/'/g, "\\'")}' in parents`);
  if (opts.query) clauses.push(`name contains '${opts.query.replace(/'/g, "\\'")}'`);

  const params = new URLSearchParams({
    q: clauses.join(" and "),
    pageSize: String(limit),
    fields: FILE_FIELDS,
    orderBy: "modifiedTime desc",
  });
  const response = await driveFetch(`/files?${params}&${SHARED_DRIVE_PARAMS}`);
  const data = (await response.json()) as { files?: DriveFile[] };
  return data.files ?? [];
}

export async function searchFullText(query: string, limit = 20): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
    pageSize: String(Math.min(Math.max(limit, 1), 100)),
    fields: FILE_FIELDS,
    orderBy: "modifiedTime desc",
  });
  const response = await driveFetch(`/files?${params}&${SHARED_DRIVE_PARAMS}`);
  const data = (await response.json()) as { files?: DriveFile[] };
  return data.files ?? [];
}

export async function getMetadata(fileId: string): Promise<DriveFile> {
  const params = new URLSearchParams({
    fields: "id,name,mimeType,modifiedTime,size,webViewLink,parents",
    supportsAllDrives: "true",
  });
  const response = await driveFetch(`/files/${encodeURIComponent(fileId)}?${params}`);
  return (await response.json()) as DriveFile;
}

export async function readFile(
  fileId: string,
): Promise<{ name: string; mimeType: string; link: string | null; content: string; truncated: boolean }> {
  const meta = await getMetadata(fileId);
  const exportAs = EXPORT_AS[meta.mimeType];

  let text: string;
  if (exportAs) {
    const params = new URLSearchParams({ mimeType: exportAs.mime, supportsAllDrives: "true" });
    const response = await driveFetch(`/files/${encodeURIComponent(fileId)}/export?${params}`);
    text = await response.text();
  } else if (READABLE_TEXT.test(meta.mimeType)) {
    const response = await driveFetch(
      `/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    );
    text = await response.text();
  } else {
    // A PDF or image would arrive as bytes the model cannot use; say so rather
    // than returning garbage.
    throw new Error(
      `"${meta.name}" is ${meta.mimeType}, which cannot be read as text. ` +
        `Open it directly: ${meta.webViewLink ?? "(no link)"}`,
    );
  }

  const truncated = text.length > MAX_CHARS;
  return {
    name: meta.name,
    mimeType: meta.mimeType,
    link: meta.webViewLink ?? null,
    content: truncated ? `${text.slice(0, MAX_CHARS)}\n\n[truncated]` : text,
    truncated,
  };
}

export { serviceAccountEmail };
