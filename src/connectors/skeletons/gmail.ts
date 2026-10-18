import { clip, objectSchema, str, strList, type Connector } from "../types.js";
import { apiJson, clientIdSetting, GOOGLE_AUTH, rawEmail } from "./http.js";

const self = { id: "gmail", name: "Gmail" };
const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const recipients = { type: "array", items: { type: "string", format: "email" }, minItems: 1 };
const message = objectSchema(
  {
    to: recipients,
    cc: { type: "array", items: { type: "string", format: "email" } },
    subject: { type: "string" },
    body: { type: "string" },
  },
  ["to", "subject", "body"],
);
const fields = { to: { label: "To" }, cc: { label: "Cc" }, subject: { label: "Subject" }, body: { label: "Message" } };
const emailSummary = (i: Record<string, unknown>) =>
  `Email to ${strList(i.to).join(", ")}: "${clip(str(i.subject), 50)}"`;

export function gmailConnector(): Connector {
  return {
    ...self,
    description: "Search your mail, write drafts and send email from Gmail.",
    icon: "mail",
    status: "skeleton",
    auth: {
      type: "oauth2-pkce",
      ...GOOGLE_AUTH,
      scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
    },
    settings: [clientIdSetting],
    actions: [
      {
        name: "search",
        description: "Search mail with Gmail search syntax. Returns sender, subject and snippet.",
        inputSchema: objectSchema({ query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, [
          "query",
        ]),
        effects: { readOnly: true },
        summarize: (i) => `Search mail for "${clip(str(i.query))}"`,
        async run(input, ctx) {
          const list = await apiJson(
            ctx,
            self,
            `${BASE}/messages?q=${encodeURIComponent(str(input.query))}&maxResults=${Number(input.limit ?? 10)}`,
          );
          const ids = ((list.messages as Array<{ id: string }> | undefined) ?? []).map((m) => m.id);
          const rows = await Promise.all(
            ids.map(async (id) => {
              const m = await apiJson(
                ctx,
                self,
                `${BASE}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
              );
              const headers = (m.payload as { headers?: Array<{ name: string; value: string }> })?.headers ?? [];
              const h = (n: string) => headers.find((x) => x.name === n)?.value ?? "";
              return `${h("From")} | ${h("Subject")} | ${str(m.snippet)}`;
            }),
          );
          return rows.length ? rows.join("\n") : "No messages found.";
        },
      },
      {
        name: "draft",
        description: "Save an email as a draft without sending it.",
        inputSchema: message,
        effects: { modifies: true },
        verb: "Save",
        fields,
        summarize: (i) => `Draft: ${emailSummary(i)}`,
        async run(input, ctx) {
          const raw = rawEmail(strList(input.to), str(input.subject), str(input.body), strList(input.cc));
          const r = await apiJson(ctx, self, `${BASE}/drafts`, { method: "POST", json: { message: { raw } } });
          return `Draft saved (${str(r.id)}).`;
        },
      },
      {
        name: "send",
        description: "Send an email.",
        inputSchema: message,
        effects: { sends: true },
        verb: "Send",
        fields,
        summarize: emailSummary,
        async run(input, ctx) {
          const raw = rawEmail(strList(input.to), str(input.subject), str(input.body), strList(input.cc));
          const r = await apiJson(ctx, self, `${BASE}/messages/send`, { method: "POST", json: { raw } });
          return `Sent (${str(r.id)}).`;
        },
      },
    ],
  };
}
