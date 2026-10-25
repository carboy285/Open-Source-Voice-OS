import { z } from "zod";
import type { ToolHost, ToolSpec } from "../core/types.js";

/** Runs a command and returns stdout. Same shape as the macOS helper's Exec, so tests need no Mac. */
export type Exec = (command: string, args: string[], input?: string) => Promise<string>;

interface BuiltinTool {
  name: string;
  description: string;
  /** Read-only tools run without asking. Anything that changes state or reveals private data asks first. */
  readOnly: boolean;
  schema: z.ZodType;
  run(input: any): Promise<string>;
}

const Iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "Use local time as YYYY-MM-DDTHH:MM.");

/** Splits "2026-10-24T15:30" into numbers. AppleScript builds the date from these, never from parsed text. */
export function dateParts(iso: string): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!match) throw new Error("Use local time as YYYY-MM-DDTHH:MM.");
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const check = new Date(year, month - 1, day, hour, minute);
  if (check.getMonth() !== month - 1 || check.getDate() !== day) throw new Error(`${iso} is not a real date.`);
  return [year, month, day, hour, minute].map(String);
}

/** AppleScript that sets `d` to the date in argv items `at` .. `at + 4`. Day is set first so month changes cannot overflow. */
const buildDate = (name: string, at: number) => `
  set ${name} to current date
  set day of ${name} to 1
  set year of ${name} to (item ${at} of argv) as integer
  set month of ${name} to (item ${at + 1} of argv) as integer
  set day of ${name} to (item ${at + 2} of argv) as integer
  set time of ${name} to ((item ${at + 3} of argv) as integer) * 3600 + ((item ${at + 4} of argv) as integer) * 60`;

const htmlEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const searchUrl = (query: string) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;

export function parseHttpUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("That is not a valid URL."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https links can be opened.");
  return url.toString();
}

/** Tools that work with no MCP setup: macOS apps, the clipboard, files and the web. */
export class BuiltinToolHost implements ToolHost {
  private readonly tools: BuiltinTool[];

  constructor(private readonly exec: Exec, private readonly now: () => Date = () => new Date()) {
    // User text always travels as an argument (argv) to a fixed script, so it can never become script code.
    const script = (body: string, ...args: string[]) => this.exec("osascript", ["-e", `on run argv\n${body}\nend run`, ...args]);
    this.tools = [
      {
        name: "get_datetime", readOnly: true, schema: z.object({}),
        description: "The current local date, time and time zone. Call before setting reminders or events with relative times like 'tomorrow'.",
        run: async () => {
          const now = this.now();
          const pad = (n: number) => String(n).padStart(2, "0");
          const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
          return `${local} (${now.toLocaleDateString("en-US", { weekday: "long" })}, ${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
        },
      },
      {
        name: "create_reminder", readOnly: false,
        description: "Create a reminder in the Reminders app.",
        schema: z.object({ title: z.string().min(1), due: Iso.optional().describe("Local due time, YYYY-MM-DDTHH:MM"), notes: z.string().optional() }),
        run: async ({ title, due, notes }: { title: string; due?: string; notes?: string }) => {
          const props = `{name:(item 1 of argv), body:(item 2 of argv)${due ? ", due date:d" : ""}}`;
          await script(`${due ? buildDate("d", 3) : ""}\ntell application "Reminders" to make new reminder with properties ${props}`, title, notes ?? "", ...(due ? dateParts(due) : []));
          return `Reminder "${title}" created${due ? ` for ${due}` : ""}.`;
        },
      },
      {
        name: "create_event", readOnly: false,
        description: "Add an event to the default writable calendar in the Calendar app.",
        schema: z.object({ title: z.string().min(1), start: Iso, durationMinutes: z.number().int().min(1).max(1440).default(60), notes: z.string().optional() }),
        run: async ({ title, start, durationMinutes, notes }: { title: string; start: string; durationMinutes: number; notes?: string }) => {
          await script(`${buildDate("s", 4)}
  set e to s + ((item 3 of argv) as integer) * 60
  tell application "Calendar"
    tell (first calendar whose writable is true) to make new event with properties {summary:(item 1 of argv), start date:s, end date:e, description:(item 2 of argv)}
  end tell`, title, notes ?? "", String(durationMinutes), ...dateParts(start));
          return `Event "${title}" added for ${start} (${durationMinutes} min).`;
        },
      },
      {
        name: "create_note", readOnly: false,
        description: "Create a note in the Notes app.",
        schema: z.object({ title: z.string().min(1), body: z.string().default("") }),
        run: async ({ title, body }: { title: string; body: string }) => {
          const html = `<h1>${htmlEscape(title)}</h1>${body.split("\n").map(line => `<div>${htmlEscape(line) || "<br>"}</div>`).join("")}`;
          await script(`tell application "Notes" to make new note with properties {name:(item 1 of argv), body:(item 2 of argv)}`, title, html);
          return `Note "${title}" created.`;
        },
      },
      {
        name: "draft_email", readOnly: false,
        description: "Open a new draft in the Mail app. It is never sent: the user reviews and sends it.",
        schema: z.object({ to: z.array(z.string().min(3)).min(1), subject: z.string(), body: z.string() }),
        run: async ({ to, subject, body }: { to: string[]; subject: string; body: string }) => {
          await script(`tell application "Mail"
    set m to make new outgoing message with properties {subject:(item 1 of argv), content:(item 2 of argv), visible:true}
    repeat with i from 3 to count of argv
      tell m to make new to recipient at end of to recipients with properties {address:(item i of argv)}
    end repeat
    activate
  end tell`, subject, body, ...to);
          return `Draft to ${to.join(", ")} opened in Mail. It has not been sent.`;
        },
      },
      {
        name: "send_message", readOnly: false,
        description: "Send an iMessage to a phone number or Apple ID email address.",
        schema: z.object({ to: z.string().min(3), text: z.string().min(1) }),
        run: async ({ to, text }: { to: string; text: string }) => {
          await script(`tell application "Messages"
    set theService to 1st service whose service type = iMessage
    send (item 2 of argv) to buddy (item 1 of argv) of theService
  end tell`, to, text);
          return `Message sent to ${to}.`;
        },
      },
      {
        name: "open_app", readOnly: false,
        description: "Open or switch to a Mac application by name.",
        schema: z.object({ name: z.string().regex(/^[\w .&+()'-]{1,64}$/, "Use the plain application name.") }),
        run: async ({ name }: { name: string }) => { await this.exec("open", ["-a", name]); return `Opened ${name}.`; },
      },
      {
        name: "open_url", readOnly: false,
        description: "Open an http or https link in the default browser.",
        schema: z.object({ url: z.string() }),
        run: async ({ url }: { url: string }) => { const safe = parseHttpUrl(url); await this.exec("open", [safe]); return `Opened ${safe}.`; },
      },
      {
        name: "web_search", readOnly: false,
        description: "Search the web by opening results in the user's browser. It does not return the results to you.",
        schema: z.object({ query: z.string().min(1) }),
        run: async ({ query }: { query: string }) => { await this.exec("open", [searchUrl(query)]); return `Opened a web search for "${query}".`; },
      },
      {
        name: "search_files", readOnly: true,
        description: "Find files by name with Spotlight. Returns up to 20 paths.",
        schema: z.object({ query: z.string().min(1), folder: z.string().startsWith("/").optional().describe("Absolute folder to search in") }),
        run: async ({ query, folder }: { query: string; folder?: string }) => {
          const out = await this.exec("mdfind", [...(folder ? ["-onlyin", folder] : []), "-name", query]);
          const paths = out.split("\n").filter(path => path && !/\/(Library|node_modules|\.[^/]+)\//.test(path)).slice(0, 20);
          return paths.length ? paths.join("\n") : "No matching files.";
        },
      },
      {
        // Not read-only: the clipboard often holds secrets, and its contents go to the model.
        name: "clipboard_read", readOnly: false, schema: z.object({}),
        description: "Read the current clipboard text.",
        run: async () => (await this.exec("pbpaste", [])) || "The clipboard is empty.",
      },
      {
        name: "clipboard_write", readOnly: false, schema: z.object({ text: z.string() }),
        description: "Replace the clipboard text.",
        run: async ({ text }: { text: string }) => { await this.exec("pbcopy", [], text); return "Copied to the clipboard."; },
      },
    ];
  }

  async list(): Promise<ToolSpec[]> {
    return this.tools.map(({ name, description, readOnly, schema }) => {
      const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
      return { name, description, readOnly, inputSchema };
    });
  }

  has(name: string): boolean { return this.tools.some(tool => tool.name === name); }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    const tool = this.tools.find(candidate => candidate.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid input for ${name}: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "input"} ${issue.message}`).join("; ")}`);
    return tool.run(parsed.data);
  }
}
