import { clip, objectSchema, str, type Connector } from "../types.js";
import { apiJson, clientIdSetting } from "./http.js";

const self = { id: "slack", name: "Slack", tokenUrl: "https://slack.com/api/oauth.v2.access" };

export function slackConnector(): Connector {
  return {
    id: self.id,
    name: self.name,
    description: "Search messages and post to channels or people in Slack.",
    icon: "chat",
    status: "skeleton",
    auth: {
      type: "oauth2-pkce",
      authorizeUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      scopes: ["search:read", "chat:write"],
      extraParams: { user_scope: "search:read,chat:write" },
    },
    settings: [clientIdSetting],
    actions: [
      {
        name: "search",
        description: "Search messages you can see.",
        inputSchema: objectSchema({ query: { type: "string", minLength: 1 } }, ["query"]),
        effects: { readOnly: true },
        summarize: (i) => `Search Slack for "${clip(str(i.query))}"`,
        async run(input, ctx) {
          const r = await apiJson(
            ctx,
            self,
            `https://slack.com/api/search.messages?count=10&query=${encodeURIComponent(str(input.query))}`,
          );
          const matches =
            (r.messages as { matches?: Array<{ username?: string; text?: string; channel?: { name?: string } }> })
              ?.matches ?? [];
          return matches.length
            ? matches.map((m) => `#${m.channel?.name ?? "?"} ${m.username ?? ""}: ${m.text ?? ""}`).join("\n")
            : "No messages found.";
        },
      },
      {
        name: "post_message",
        description: "Post a message to a channel (#name or id) or a person (user id).",
        inputSchema: objectSchema(
          { channel: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1 } },
          ["channel", "text"],
        ),
        effects: { sends: true },
        verb: "Send",
        fields: { channel: { label: "To", type: "recipients" }, text: { label: "Message", type: "longtext" } },
        summarize: (i) => `Message to ${str(i.channel)}: "${clip(str(i.text), 50)}"`,
        async run(input, ctx) {
          const r = await apiJson(ctx, self, "https://slack.com/api/chat.postMessage", {
            method: "POST",
            json: { channel: str(input.channel).replace(/^#/, ""), text: str(input.text) },
          });
          return `Posted (${str(r.ts)}).`;
        },
      },
    ],
  };
}
