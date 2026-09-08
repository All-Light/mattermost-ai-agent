// Read-only tools over the UUAIS shared drive. There is no write path: the
// OAuth scope is drive.readonly, so Google refuses edits regardless of intent.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  driveConfigured,
  getMetadata,
  listDrives,
  listFiles,
  readFile,
  searchFullText,
  serviceAccountEmail,
} from "../google/drive";

function requireDrive(): void {
  if (!driveConfigured()) throw new Error("Google Drive access is not configured.");
}

function summarise(f: { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string }) {
  return {
    id: f.id,
    name: f.name,
    type: f.mimeType.replace("application/vnd.google-apps.", ""),
    modified: f.modifiedTime ?? null,
    link: f.webViewLink ?? null,
  };
}

export const listDriveFiles = createTool({
  id: "list_drive_files",
  description:
    "List files on the UUAIS shared drive, most recently modified first. " +
    "Read-only. Use search_drive to find something by its contents rather than " +
    "its name.",
  inputSchema: z.object({
    name_contains: z.string().optional().describe("Filter by filename"),
    folder_id: z.string().optional().describe("List inside one folder"),
    limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
  }),
  execute: async ({ name_contains, folder_id, limit }) => {
    requireDrive();
    const files = await listFiles({ query: name_contains, folderId: folder_id, limit });
    return { count: files.length, files: files.map(summarise) };
  },
});

export const searchDrive = createTool({
  id: "search_drive",
  description:
    "Full-text search across the shared drive — matches document contents, not " +
    "just filenames. Use this first when looking for information rather than a " +
    "known file.",
  inputSchema: z.object({
    query: z.string(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  execute: async ({ query, limit }) => {
    requireDrive();
    const files = await searchFullText(query, limit);
    return { query, count: files.length, files: files.map(summarise) };
  },
});

export const readDriveFile = createTool({
  id: "read_drive_file",
  description:
    "Read a file's text from the shared drive. Google Docs, Sheets and Slides " +
    "are exported as text or CSV; plain-text files are read directly. PDFs and " +
    "images cannot be read — link the member to those instead. Get the id from " +
    "list_drive_files or search_drive.",
  inputSchema: z.object({ file_id: z.string().describe("File id from list_drive_files") }),
  execute: async ({ file_id }) => {
    requireDrive();
    return readFile(file_id);
  },
});

export const listSharedDrives = createTool({
  id: "list_shared_drives",
  description:
    "List the shared drives the bot has been given access to. Useful when a " +
    "file cannot be found, to check what it can actually see.",
  inputSchema: z.object({}),
  execute: async () => {
    requireDrive();
    const drives = await listDrives();
    return {
      bot_identity: serviceAccountEmail(),
      count: drives.length,
      drives,
      ...(drives.length
        ? {}
        : {
            hint:
              "No shared drives are visible. The drive must be shared with " +
              `${serviceAccountEmail()}; sharing it with bot@uuais.com does not grant the agent access.`,
          }),
    };
  },
});

export const driveTools = {
  list_drive_files: listDriveFiles,
  search_drive: searchDrive,
  read_drive_file: readDriveFile,
  list_shared_drives: listSharedDrives,
};

export { getMetadata };
