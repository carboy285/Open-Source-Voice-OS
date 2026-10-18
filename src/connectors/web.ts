import { clip, objectSchema, str, type Connector, type ConnectorContext } from "./types.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** A web search provider. Murmur ships none with a built-in key. */
export interface SearchBackend {
  search(query: string, count: number, ctx: ConnectorContext): Promise<SearchResult[]>;
}

export const WEB_SEARCH_KEY = "connector/web/apiKey";

/** Brave Search API, with the user's own key. */
export const braveBackend: SearchBackend = {
  async search(query, count, ctx) {
    const key = await ctx.secrets.get(WEB_SEARCH_KEY);
    if (!key) throw new Error("Add a Brave Search API key in Settings › Connectors › Web search.");
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const res = await ctx.fetch(url, { headers: { accept: "application/json", "x-subscription-token": key } });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    const json = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    return (json.web?.results ?? []).map((r) => ({
      title: str(r.title),
      url: str(r.url),
      snippet: stripTags(str(r.description)),
    }));
  },
};

/** A SearXNG instance the user runs or trusts (JSON output enabled). */
export const searxngBackend: SearchBackend = {
  async search(query, count, ctx) {
    const base = str(ctx.settings.searxngUrl).replace(/\/+$/, "");
    if (!base) throw new Error("Set your SearXNG address in Settings › Connectors › Web search.");
    const res = await ctx.fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    const json = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (json.results ?? [])
      .slice(0, count)
      .map((r) => ({ title: str(r.title), url: str(r.url), snippet: stripTags(str(r.content)) }));
  },
};

export const SEARCH_BACKENDS: Record<string, SearchBackend> = { brave: braveBackend, searxng: searxngBackend };

export function stripTags(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export function webConnector(backends: Record<string, SearchBackend> = SEARCH_BACKENDS): Connector {
  return {
    id: "web",
    name: "Web search",
    description: "Search the web and read pages, with a search provider you choose.",
    icon: "globe",
    auth: { type: "api-key", secretKey: WEB_SEARCH_KEY, label: "Search API key" },
    status: "ready",
    settings: [
      { key: "backend", label: "Search provider", type: "select", options: Object.keys(backends) },
      { key: "searxngUrl", label: "SearXNG address", type: "text", placeholder: "https://search.example.org" },
    ],
    actions: [
      {
        name: "search",
        description: "Search the web. Returns titles, links and snippets.",
        inputSchema: objectSchema(
          { query: { type: "string", minLength: 1 }, count: { type: "integer", minimum: 1, maximum: 10 } },
          ["query"],
        ),
        effects: { readOnly: true },
        summarize: (i) => `Search the web for "${clip(str(i.query))}"`,
        async run(input, ctx) {
          const backend = backends[str(ctx.settings.backend)];
          if (!backend) throw new Error("Choose a search provider in Settings › Connectors › Web search.");
          const results = await backend.search(str(input.query), Number(input.count ?? 5), ctx);
          if (!results.length) return "No results.";
          return results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n");
        },
      },
      {
        name: "fetch_page",
        description: "Read the text of a web page (http or https).",
        inputSchema: objectSchema({ url: { type: "string", format: "uri" } }, ["url"]),
        effects: { readOnly: true },
        summarize: (i) => `Read ${clip(str(i.url), 80)}`,
        async run(input, ctx) {
          const url = new URL(str(input.url));
          if (url.protocol !== "http:" && url.protocol !== "https:")
            throw new Error("Only http and https pages can be read.");
          const res = await ctx.fetch(url, { headers: { accept: "text/html,text/plain" }, redirect: "follow" });
          if (!res.ok) throw new Error(`Could not load the page (${res.status})`);
          const body = await res.text();
          const text = /html/i.test(res.headers.get("content-type") ?? "") ? stripTags(body) : body;
          return text.length > 8000 ? `${text.slice(0, 8000)}…` : text;
        },
      },
    ],
  };
}
