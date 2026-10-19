import { randomUUID } from "node:crypto";
import type { SideEffects, ToolHost, ToolSpec } from "../core/types.js";
import { describeError } from "../core/redact.js";
import { genericSummary } from "../gate/preview.js";
import type { SecretStore } from "../secrets/store.js";
import { cleanSchema, classifyEffects } from "./classify.js";
import {
  COMPOSIO_KEY,
  ComposioClient,
  ComposioError,
  normalizeSlug,
  type ComposioTool,
  type ConnectedAccount,
  type Toolkit,
} from "./client.js";

export interface AppSettings {
  enabled: boolean;
  /** Hide every tool that changes something; the agent can only read. */
  readOnly: boolean;
}

export interface SettingsStore {
  get(key: "composio.userId"): string;
  get(key: "composio.apps"): Record<string, AppSettings>;
  set(key: string, value: unknown): void;
}

export type ComposioEvent = {
  type: "composio.connect";
  toolkit: string;
  name: string;
  state: "waiting" | "done" | "failed";
  error?: string;
};

export interface ComposioOptions {
  secrets: SecretStore;
  settings: SettingsStore;
  emit(event: ComposioEvent): void;
  /** Opens a sign-in page in the user's browser. */
  openUrl(url: string): Promise<void>;
  fetch?: typeof fetch;
  /** Replaces the wait between sign-in checks; tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
  signInTimeoutMs?: number;
  now?: () => number;
}

export const NEEDS_KEY =
  "Murmur isn't linked to Composio yet. Add a Composio API key in Settings > Apps, then ask again.";
const OUTPUT_LIMIT = 8000;
/** Composio's search toolkit: web, news and similar searches, with no sign-in. */
export const SEARCH_TOOLKIT = "composio_search";
const TOOLS_TTL = 10 * 60_000;
const CONNECTIONS_TTL = 20_000;
/** Apps people ask for most, so the agent can offer them before the catalog has loaded. */
const POPULAR = ["gmail", "googlecalendar", "googledrive", "googlesheets", "slack", "notion", "github", "linear"];

const ICONS: Array<[RegExp, string]> = [
  [/mail|outlook/, "mail"],
  [/calendar/, "calendar"],
  [/slack|discord|teams|whatsapp|telegram/, "chat"],
  [/notion|docs|sheets|drive|dropbox|onedrive|box/, "doc"],
  [/linear|jira|asana|trello|github|gitlab|clickup|todoist/, "issue"],
];
const iconFor = (slug: string) => ICONS.find(([re]) => re.test(slug))?.[1] ?? "cloud";

export interface AppState {
  slug: string;
  name: string;
  description: string;
  connected: boolean;
  accountId?: string;
  enabled: boolean;
  readOnly: boolean;
}

/** The user's Composio link: the key, the apps they connected, and the tools those apps give the agent. */
export class ComposioService {
  private toolkitCache?: { at: number; list: Toolkit[] };
  private accountCache?: { at: number; list: ConnectedAccount[] };
  private readonly toolCache = new Map<string, { at: number; tools: ComposioTool[] }>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ComposioOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  // The key

  async hasKey(): Promise<boolean> {
    return Boolean(await this.options.secrets.get(COMPOSIO_KEY));
  }

  private async client(): Promise<ComposioClient> {
    const key = await this.options.secrets.get(COMPOSIO_KEY);
    if (!key) throw new ComposioError(NEEDS_KEY);
    return new ComposioClient(key, this.options.fetch);
  }

  /** Checks the key with Composio, then keeps it in the keychain. */
  async setKey(key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) throw new ComposioError("Paste your Composio API key.");
    await new ComposioClient(trimmed, this.options.fetch).check();
    await this.options.secrets.set(COMPOSIO_KEY, trimmed);
    this.forget();
  }

  /** Removes the key. Apps stay connected on Composio's side until you disconnect them there. */
  async removeKey(): Promise<void> {
    await this.options.secrets.delete(COMPOSIO_KEY);
    this.forget();
  }

  private forget(): void {
    this.toolkitCache = undefined;
    this.accountCache = undefined;
    this.toolCache.clear();
  }

  /** A random id for this install, so Composio can tell users of the same key apart. */
  userId(): string {
    let id = this.options.settings.get("composio.userId");
    if (!id) {
      id = `murmur-${randomUUID()}`;
      this.options.settings.set("composio.userId", id);
    }
    return id;
  }

  // Apps

  private async toolkits(): Promise<Toolkit[]> {
    if (this.toolkitCache && this.now() - this.toolkitCache.at < 60 * 60_000) return this.toolkitCache.list;
    const list = await (await this.client()).toolkits();
    this.toolkitCache = { at: this.now(), list };
    return list;
  }

  private async accounts(fresh = false): Promise<ConnectedAccount[]> {
    if (!fresh && this.accountCache && this.now() - this.accountCache.at < CONNECTIONS_TTL) {
      return this.accountCache.list;
    }
    const list = await (await this.client()).connections(this.userId());
    this.accountCache = { at: this.now(), list };
    return list;
  }

  private appSettings(slug: string): AppSettings {
    return { enabled: true, readOnly: false, ...this.options.settings.get("composio.apps")[slug] };
  }

  /** Every app Composio offers (or matches `query`), with whether you connected it. */
  async apps(query?: string): Promise<AppState[]> {
    const client = await this.client();
    const [list, accounts] = await Promise.all([query ? client.toolkits(query) : this.toolkits(), this.accounts(true)]);
    const active = new Map(accounts.filter((a) => a.status === "ACTIVE").map((a) => [a.toolkit, a]));
    const known = new Set(list.map((t) => t.slug));
    const extra = [...active.keys()]
      .filter((slug) => !known.has(slug))
      .map((slug) => ({ slug, name: slug, description: "" }));
    return [...list, ...extra].map((t) => {
      const account = active.get(t.slug);
      const s = this.appSettings(t.slug);
      return {
        slug: t.slug,
        name: t.name,
        description: t.description,
        connected: account !== undefined,
        accountId: account?.id,
        enabled: s.enabled,
        readOnly: s.readOnly,
      };
    });
  }

  configure(slug: string, patch: Partial<AppSettings>): void {
    const all = { ...this.options.settings.get("composio.apps") };
    all[slug] = { ...this.appSettings(slug), ...patch };
    this.options.settings.set("composio.apps", all);
  }

  async disconnect(slug: string): Promise<void> {
    const client = await this.client();
    for (const account of (await this.accounts(true)).filter((a) => a.toolkit === slug)) {
      await client.disconnect(account.id);
    }
    this.accountCache = undefined;
    this.toolCache.delete(slug);
  }

  /** Finds an app from what the user or the model called it: "google calendar", "Gmail", "googlecalendar". */
  private async find(name: string): Promise<Toolkit> {
    const wanted = normalizeSlug(name);
    const list = await this.toolkits();
    const found =
      list.find((t) => t.slug === wanted) ??
      list.find((t) => normalizeSlug(t.name) === wanted) ??
      list.find((t) => t.slug.startsWith(wanted) || normalizeSlug(t.name).startsWith(wanted)) ??
      list.find((t) => wanted.length > 3 && (t.slug.includes(wanted) || normalizeSlug(t.name).includes(wanted)));
    if (!found) throw new ComposioError(`Composio has no app called "${name}".`);
    return found;
  }

  /**
   * Signs in to an app. Opens the sign-in page, then waits for the account to become active. Resolves with
   * a sentence for the agent; throws when the sign-in does not finish.
   */
  async connect(name: string): Promise<string> {
    let app: Toolkit = { slug: normalizeSlug(name), name, description: "" };
    try {
      app = await this.find(name);
      const client = await this.client();
      if ((await this.accounts(true)).some((a) => a.toolkit === app.slug && a.status === "ACTIVE")) {
        this.configure(app.slug, { enabled: true });
        return `${app.name} is already connected.`;
      }
      const { redirectUrl } = await client.link(await client.authConfig(app.slug), this.userId());
      this.options.emit({ type: "composio.connect", toolkit: app.slug, name: app.name, state: "waiting" });
      await this.options.openUrl(redirectUrl);
      const deadline = this.now() + (this.options.signInTimeoutMs ?? 3 * 60_000);
      while (this.now() < deadline) {
        await this.sleep(2000);
        if ((await this.accounts(true)).some((a) => a.toolkit === app.slug && a.status === "ACTIVE")) {
          this.configure(app.slug, { enabled: true });
          this.toolCache.delete(app.slug);
          this.options.emit({ type: "composio.connect", toolkit: app.slug, name: app.name, state: "done" });
          return `${app.name} is connected. Its tools are available now.`;
        }
      }
      throw new ComposioError(`The ${app.name} sign-in wasn't finished in time. Ask again to retry.`);
    } catch (error) {
      const message = describeError(error);
      this.options.emit({
        type: "composio.connect",
        toolkit: app.slug,
        name: app.name,
        state: "failed",
        error: message,
      });
      throw error instanceof ComposioError ? error : new Error(message);
    }
  }

  // Tools

  private async toolsFor(slug: string): Promise<ComposioTool[]> {
    const cached = this.toolCache.get(slug);
    if (cached && this.now() - cached.at < TOOLS_TTL) return cached.tools;
    const tools = (await (await this.client()).tools(slug)).slice(0, 40);
    this.toolCache.set(slug, { at: this.now(), tools });
    return tools;
  }

  /** Tool specs for every connected app that is switched on. */
  async specs(): Promise<Array<{ spec: ToolSpec; slug: string; toolkit: string; accountId: string }>> {
    if (!(await this.hasKey())) return [];
    const accounts = (await this.accounts()).filter((a) => a.status === "ACTIVE");
    const names = new Map((await this.toolkits().catch(() => [])).map((t) => [t.slug, t.name]));
    const out: Array<{ spec: ToolSpec; slug: string; toolkit: string; accountId: string }> = [];
    for (const account of accounts) {
      const settings = this.appSettings(account.toolkit);
      if (!settings.enabled) continue;
      const appName = names.get(account.toolkit) ?? account.toolkit;
      for (const tool of await this.toolsFor(account.toolkit).catch(() => [])) {
        const effects = classifyEffects(tool, account.toolkit);
        if (settings.readOnly && effects.readOnly !== true) continue;
        out.push({
          slug: tool.slug,
          toolkit: account.toolkit,
          accountId: account.id,
          spec: {
            name: `composio.${tool.slug.toLowerCase()}`,
            description: `${appName}: ${tool.description || tool.name}`.slice(0, 600),
            inputSchema: cleanSchema(tool.inputSchema),
            origin: "builtin",
            effects: effects as SideEffects,
            preview: {
              summarize: (input) => genericSummary(`${appName}: ${tool.name || tool.slug}`, input),
              icon: iconFor(account.toolkit),
              displayName: appName,
            },
          },
        });
      }
    }
    out.push(...(await this.searchSpecs()));
    return out;
  }

  /**
   * Composio's own search tools. They need no sign-in, only the Composio key, so web search works as soon as the
   * key is added. Searching changes nothing, so these run without a preview.
   */
  private async searchSpecs(): Promise<Array<{ spec: ToolSpec; slug: string; toolkit: string; accountId: string }>> {
    if (!this.appSettings(SEARCH_TOOLKIT).enabled) return [];
    const tools = await this.toolsFor(SEARCH_TOOLKIT).catch(() => []);
    // The toolkit has two dozen tools (travel, shopping, finance). Offer the general ones so the model isn't swamped.
    const general = (t: ComposioTool) =>
      /WEB|TAVILY|EXA|DUCK|NEWS|ANSWER|SEARCH/i.test(t.slug.replace(/^COMPOSIO_SEARCH_?/i, "")) ? 0 : 1;
    return [...tools]
      .sort((a, b) => general(a) - general(b))
      .slice(0, 8)
      .map((tool) => ({
        slug: tool.slug,
        toolkit: SEARCH_TOOLKIT,
        accountId: "",
        spec: {
          name: `composio.${tool.slug.toLowerCase()}`,
          description: `Web search (Composio): ${tool.description || tool.name}`.slice(0, 600),
          inputSchema: cleanSchema(tool.inputSchema),
          origin: "builtin" as const,
          effects: { readOnly: true },
          preview: {
            summarize: (input: Record<string, unknown>) => genericSummary(`Search: ${tool.name || tool.slug}`, input),
            icon: "globe",
            displayName: "Web search",
          },
        },
      }));
  }

  async run(slug: string, input: Record<string, unknown>, accountId: string): Promise<string> {
    const data = await (await this.client()).execute(slug, input, this.userId(), accountId);
    const body = typeof data === "string" ? data : JSON.stringify(data, null, 1);
    return body.length > OUTPUT_LIMIT ? `${body.slice(0, OUTPUT_LIMIT)}\n… (cut off)` : body;
  }

  async summary(): Promise<string> {
    if (!(await this.hasKey())) return NEEDS_KEY;
    const accounts = (await this.accounts(true)).filter((a) => a.status === "ACTIVE");
    const connected = accounts.map((a) => a.toolkit);
    const offer = POPULAR.filter((s) => !connected.includes(s));
    return [
      connected.length ? `Connected: ${connected.join(", ")}.` : "No apps are connected yet.",
      "Web search is built in.",
      `Can connect: ${offer.join(", ")} and more.`,
    ].join(" ");
  }
}

const connectTool: ToolSpec = {
  name: "connections.connect",
  description:
    "Connect one of the user's apps (Gmail, Google Calendar, Google Drive, Slack, Notion, GitHub, Linear and hundreds more) " +
    "through Composio. Call it when the request needs an app and none of your tools can reach it. It opens a sign-in page " +
    "and waits for the user to finish, then the app's tools become available.",
  inputSchema: {
    type: "object",
    properties: { app: { type: "string", description: 'The app, such as "Google Calendar" or "gmail".' } },
    required: ["app"],
  },
  origin: "builtin",
  effects: { modifies: true },
  preview: {
    summarize: (input) => `Sign in to ${String(input.app ?? "an app")} (opens your browser)`,
    verb: "Run",
    icon: "cloud",
    displayName: "Connect an app",
    fields: { app: { label: "App" } },
  },
};

const listTool: ToolSpec = {
  name: "connections.list",
  description: "Say which apps are connected through Composio and which popular ones can be connected.",
  inputSchema: { type: "object", properties: {}, required: [] },
  origin: "builtin",
  effects: { readOnly: true },
  preview: { summarize: () => "Check connected apps", icon: "cloud", displayName: "Connected apps" },
};

/** Gives the agent the connect tools and the tools of every connected, switched-on app. */
export class ComposioHost implements ToolHost {
  private byName = new Map<string, { slug: string; accountId: string }>();

  constructor(private readonly service: ComposioService) {}

  async list(): Promise<ToolSpec[]> {
    const entries = await this.service.specs().catch(() => []);
    this.byName = new Map(entries.map((e) => [e.spec.name, { slug: e.slug, accountId: e.accountId }]));
    return [connectTool, listTool, ...entries.map((e) => e.spec)];
  }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    if (name === connectTool.name) return this.service.connect(String(input.app ?? ""));
    if (name === listTool.name) return this.service.summary();
    if (!this.byName.has(name)) await this.list();
    const target = this.byName.get(name);
    if (!target) throw new Error(`Unknown tool: ${name}`);
    return this.service.run(target.slug, input, target.accountId);
  }
}
