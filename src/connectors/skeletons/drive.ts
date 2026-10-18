import { clip, objectSchema, str, type Connector } from "../types.js";
import { apiJson, clientIdSetting, GOOGLE_AUTH } from "./http.js";

const self = { id: "drive", name: "Google Drive", tokenUrl: "https://oauth2.googleapis.com/token" };

export function driveConnector(): Connector {
  return {
    id: self.id,
    name: self.name,
    description: "Find files in Google Drive and create Google Docs.",
    icon: "cloud",
    status: "skeleton",
    auth: {
      type: "oauth2-pkce",
      ...GOOGLE_AUTH,
      scopes: ["https://www.googleapis.com/auth/drive.metadata.readonly", "https://www.googleapis.com/auth/drive.file"],
    },
    settings: [clientIdSetting],
    actions: [
      {
        name: "search",
        description: "Find files whose name contains the query.",
        inputSchema: objectSchema({ query: { type: "string", minLength: 1 } }, ["query"]),
        effects: { readOnly: true },
        summarize: (i) => `Search Drive for "${clip(str(i.query))}"`,
        async run(input, ctx) {
          const q = `name contains '${str(input.query).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed = false`;
          const r = await apiJson(
            ctx,
            self,
            `https://www.googleapis.com/drive/v3/files?pageSize=10&fields=files(id,name,webViewLink)&q=${encodeURIComponent(q)}`,
          );
          const files = (r.files as Array<{ name: string; webViewLink?: string }>) ?? [];
          return files.length ? files.map((f) => `${f.name} ${f.webViewLink ?? ""}`).join("\n") : "No files found.";
        },
      },
      {
        name: "create_doc",
        description: "Create a Google Doc with a title and optional text.",
        inputSchema: objectSchema({ title: { type: "string", minLength: 1 }, content: { type: "string" } }, ["title"]),
        effects: { modifies: true },
        verb: "Save",
        fields: { title: { label: "Title" }, content: { label: "Text", type: "longtext" } },
        summarize: (i) => `New Google Doc "${clip(str(i.title))}"`,
        async run(input, ctx) {
          const doc = await apiJson(ctx, self, "https://docs.googleapis.com/v1/documents", {
            method: "POST",
            json: { title: str(input.title) },
          });
          const id = str(doc.documentId);
          if (str(input.content)) {
            await apiJson(ctx, self, `https://docs.googleapis.com/v1/documents/${id}:batchUpdate`, {
              method: "POST",
              json: { requests: [{ insertText: { location: { index: 1 }, text: str(input.content) } }] },
            });
          }
          return `Created https://docs.google.com/document/d/${id}/edit`;
        },
      },
    ],
  };
}
