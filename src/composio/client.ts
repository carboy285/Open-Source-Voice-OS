import { describeError } from "../core/redact.js";

/**
 * A small client for Composio's REST API (https://docs.composio.dev/reference). Composio runs the sign-in for
 * Gmail, Google Calendar and similar apps and holds those tokens; Murmur keeps only the user's Composio API key
 * and a random user id. Everything the response shapes are read through the `pick*` helpers below, so a field
 * that moves does not crash the app.
 */
export const COMPOSIO_BASE = "https://backend.composio.dev";
export const COMPOSIO_KEY = "composio/apiKey";

export interface Toolkit {
  slug: string;
  name: string;
  description: string;
  logo?: string;
}

export interface ConnectedAccount {
  id: string;
  toolkit: string;
  status: string;
}

export interface ComposioTool {
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  tags: string[];
}

export class ComposioError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const text = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const items = (v: unknown): Json[] => {
  const o = obj(v);
  const list = Array.isArray(v) ? v : (o.items ?? o.data ?? o.results);
  return Array.isArray(list) ? list.map(obj) : [];
};

export const normalizeSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export class ComposioClient {
  constructor(
    private readonly apiKey: string,
    private readonly doFetch: typeof fetch = fetch,
    private readonly base = COMPOSIO_BASE,
  ) {}

  private async call(method: string, path: string, options: { query?: Json; body?: unknown } = {}): Promise<Json> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v === undefined || v === "") continue;
      for (const value of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(value));
    }
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method,
        headers: {
          "x-api-key": this.apiKey,
          accept: "application/json",
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ComposioError(`Couldn't reach Composio: ${describeError(error)}`);
    }
    const raw = await response.text();
    let json: Json = {};
    try {
      json = raw ? (JSON.parse(raw) as Json) : {};
    } catch {
      /* not JSON; handled below */
    }
    if (!response.ok) {
      const detail = text(obj(json.error).message) || text(json.message) || raw.slice(0, 200);
      if (response.status === 401 || response.status === 403) {
        throw new ComposioError("Composio didn't accept the API key. Check it in Settings.", response.status);
      }
      throw new ComposioError(`Composio said ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
    }
    return json;
  }

  /** Throws when the key is wrong. */
  async check(): Promise<void> {
    await this.call("GET", "/api/v3/toolkits", { query: { limit: 1 } });
  }

  async toolkits(query?: string): Promise<Toolkit[]> {
    const out: Toolkit[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page++) {
      const json = await this.call("GET", "/api/v3/toolkits", {
        query: { limit: 100, sort_by: "usage", cursor, search: query },
      });
      for (const t of items(json)) {
        const meta = obj(t.meta);
        const slug = text(t.slug);
        if (slug)
          out.push({ slug, name: text(t.name, slug), description: text(meta.description), logo: text(meta.logo) });
      }
      cursor = text(json.next_cursor) || undefined;
      if (!cursor || query) break;
    }
    return out;
  }

  async connections(userId: string): Promise<ConnectedAccount[]> {
    const json = await this.call("GET", "/api/v3/connected_accounts", { query: { user_ids: userId, limit: 100 } });
    return items(json)
      .map((a) => ({ id: text(a.id), toolkit: text(obj(a.toolkit).slug), status: text(a.status).toUpperCase() }))
      .filter((a) => a.id && a.toolkit);
  }

  /** The auth config Murmur reuses for a toolkit; created with Composio's own sign-in app when there is none. */
  async authConfig(toolkit: string): Promise<string> {
    const existing = items(await this.call("GET", "/api/v3/auth_configs", { query: { toolkit_slug: toolkit } }));
    const found = existing.find((c) => text(c.id) && text(c.status, "ENABLED").toUpperCase() !== "DISABLED");
    if (found) return text(found.id);
    const created = await this.call("POST", "/api/v3/auth_configs", {
      body: { toolkit: { slug: toolkit }, auth_config: { type: "use_composio_managed_auth" } },
    });
    const id = text(obj(created.auth_config).id) || text(created.id);
    if (!id) throw new ComposioError(`Composio can't sign in to ${toolkit} without your own app credentials.`);
    return id;
  }

  /** Starts a sign-in. The user opens `redirectUrl` in a browser. */
  async link(authConfigId: string, userId: string): Promise<{ redirectUrl: string; accountId: string }> {
    const json = await this.call("POST", "/api/v3/connected_accounts/link", {
      body: { auth_config_id: authConfigId, user_id: userId },
    });
    const redirectUrl = text(json.redirect_url) || text(json.redirectUrl);
    if (!redirectUrl.startsWith("https://")) throw new ComposioError("Composio didn't return a sign-in link.");
    return { redirectUrl, accountId: text(json.connected_account_id) || text(json.id) };
  }

  async disconnect(accountId: string): Promise<void> {
    await this.call("DELETE", `/api/v3/connected_accounts/${encodeURIComponent(accountId)}`);
  }

  async tools(toolkit: string): Promise<ComposioTool[]> {
    const read = async (important: boolean) =>
      items(
        await this.call("GET", "/api/v3/tools", {
          query: { toolkit_slug: toolkit, limit: 100, ...(important ? { important: "true" } : {}) },
        }),
      );
    let list = await read(true).catch(() => []);
    if (!list.length) list = await read(false);
    return list
      .map((t) => ({
        slug: text(t.slug),
        name: text(t.name),
        description: text(t.description),
        inputSchema: obj(t.input_parameters ?? t.inputParameters),
        tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
      }))
      .filter((t) => t.slug);
  }

  async execute(slug: string, args: Json, userId: string, accountId?: string): Promise<unknown> {
    const json = await this.call("POST", `/api/v3/tools/execute/${encodeURIComponent(slug)}`, {
      body: { user_id: userId, ...(accountId ? { connected_account_id: accountId } : {}), arguments: args },
    });
    if (json.successful === false || (json.error && !json.data)) {
      throw new ComposioError(text(obj(json.error).message) || text(json.error) || "The app returned an error.");
    }
    return json.data ?? json;
  }
}
