import { clip, objectSchema, str, type Connector } from "../types.js";
import { apiJson, clientIdSetting } from "./http.js";

const self = { id: "notion", name: "Notion" };
const VERSION = { "notion-version": "2022-06-28" };

export function notionConnector(): Connector {
  return {
    ...self,
    description: "Search pages and create new ones in Notion.",
    icon: "doc",
    status: "skeleton",
    auth: {
      type: "oauth2-pkce",
      authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
      tokenUrl: "https://api.notion.com/v1/oauth/token",
      scopes: [],
      extraParams: { owner: "user" },
    },
    settings: [clientIdSetting],
    actions: [
      {
        name: "search",
        description: "Search pages shared with Murmur.",
        inputSchema: objectSchema({ query: { type: "string" } }, ["query"]),
        effects: { readOnly: true },
        summarize: (i) => `Search Notion for "${clip(str(i.query))}"`,
        async run(input, ctx) {
          const r = await apiJson(ctx, self, "https://api.notion.com/v1/search", {
            method: "POST",
            headers: VERSION,
            json: { query: str(input.query), page_size: 10 },
          });
          const results = (r.results as Array<{ id: string; url?: string }>) ?? [];
          return results.length ? results.map((p) => `${p.id} ${p.url ?? ""}`).join("\n") : "No pages found.";
        },
      },
      {
        name: "create_page",
        description: "Create a page under a parent page id.",
        inputSchema: objectSchema(
          {
            parentId: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
            content: { type: "string" },
          },
          ["parentId", "title"],
        ),
        effects: { modifies: true },
        verb: "Save",
        fields: {
          parentId: { label: "Parent page" },
          title: { label: "Title" },
          content: { label: "Content", type: "longtext" },
        },
        summarize: (i) => `New Notion page "${clip(str(i.title))}"`,
        async run(input, ctx) {
          const paragraphs = str(input.content)
            .split(/\n{2,}/)
            .filter(Boolean)
            .map((text) => ({
              object: "block",
              type: "paragraph",
              paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
            }));
          const r = await apiJson(ctx, self, "https://api.notion.com/v1/pages", {
            method: "POST",
            headers: VERSION,
            json: {
              parent: { page_id: str(input.parentId) },
              properties: { title: { title: [{ text: { content: str(input.title) } }] } },
              children: paragraphs,
            },
          });
          return `Created ${str(r.url)}`;
        },
      },
    ],
  };
}
