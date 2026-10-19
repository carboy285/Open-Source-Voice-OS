import { describe, expect, it } from "vitest";
import { classifyEffects, cleanSchema } from "../src/composio/classify.js";
import { COMPOSIO_KEY } from "../src/composio/client.js";
import { ComposioHost, ComposioService, NEEDS_KEY, type ComposioEvent } from "../src/composio/service.js";
import { ApprovalGate } from "../src/gate/gate.js";
import { runAgent } from "../src/modes/agent.js";
import { MemorySecretStore } from "../src/secrets/store.js";
import { DEFAULT_SETTINGS } from "../src/storage/repos.js";
import { ScriptedApprovalUi } from "./fakes/approval.js";
import { ScriptedLlm, toolCall } from "./fakes/llm.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Composio tool classification", () => {
  const tool = (slug: string, tags: string[] = []) => ({ slug, tags });
  it("treats clear read names as read-only", () => {
    expect(classifyEffects(tool("GMAIL_FETCH_EMAILS"), "gmail")).toEqual({ readOnly: true });
    expect(classifyEffects(tool("GOOGLECALENDAR_EVENTS_LIST"), "googlecalendar")).toEqual({ readOnly: true });
    expect(classifyEffects(tool("GMAIL_LIST_LABELS"), "gmail")).toEqual({ readOnly: true });
  });
  it("gates anything that writes, sends or deletes", () => {
    expect(classifyEffects(tool("GMAIL_SEND_EMAIL"), "gmail")).toMatchObject({ sends: true, modifies: true });
    expect(classifyEffects(tool("GMAIL_DELETE_MESSAGE"), "gmail")).toMatchObject({ destructive: true });
    expect(classifyEffects(tool("GOOGLECALENDAR_CREATE_EVENT"), "googlecalendar")).toEqual({ modifies: true });
    expect(classifyEffects(tool("GMAIL_FETCH_AND_DELETE"), "gmail").readOnly).toBeUndefined();
  });
  it("gates a name it does not recognise, and a destructive hint beats a read name", () => {
    expect(classifyEffects(tool("NOTION_FROBNICATE_PAGE"), "notion").readOnly).toBeUndefined();
    expect(classifyEffects(tool("GMAIL_GET_THING", ["destructiveHint"]), "gmail").readOnly).toBeUndefined();
  });
});

describe("cleanSchema", () => {
  it("keeps the parts every model accepts and drops the rest", () => {
    const out = cleanSchema({
      type: "object",
      title: "X",
      additionalProperties: false,
      properties: { q: { type: "string", description: "x".repeat(500), examples: ["a"], default: "z" } },
      required: ["q", "missing"],
    });
    expect(out).toEqual({
      type: "object",
      properties: { q: { type: "string", description: "x".repeat(240) } },
      required: ["q"],
    });
  });
  it("makes a missing schema an empty object schema", () => {
    expect(cleanSchema(undefined)).toEqual({ type: "object", properties: {} });
  });
});

function setup(opts: { signedIn?: boolean; withKey?: boolean; neverFinishes?: boolean } = {}) {
  const secrets = new MemorySecretStore();
  if (opts.withKey !== false) secrets.values.set(COMPOSIO_KEY, "ck_test");
  const store: Record<string, unknown> = { ...structuredClone(DEFAULT_SETTINGS) };
  const events: ComposioEvent[] = [];
  const opened: string[] = [];
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown>; key?: string }> = [];
  let active = false;
  let clock = 0;
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const headers = init?.headers as Record<string, string>;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body, key: headers["x-api-key"] });
    const path = url.pathname;
    if (path === "/api/v3/toolkits")
      return json({
        items: [
          { slug: "gmail", name: "Gmail", meta: { description: "Email" } },
          { slug: "googlecalendar", name: "Google Calendar", meta: { description: "Events" } },
        ],
      });
    if (path === "/api/v3/auth_configs" && init?.method !== "POST") return json({ items: [] });
    if (path === "/api/v3/auth_configs") return json({ auth_config: { id: "ac_1" } });
    if (path === "/api/v3/connected_accounts/link")
      return json({ redirect_url: "https://connect.example/sign-in", connected_account_id: "ca_1" });
    if (path === "/api/v3/connected_accounts")
      return json({
        items: active || opts.signedIn ? [{ id: "ca_1", status: "ACTIVE", toolkit: { slug: "googlecalendar" } }] : [],
      });
    if (path === "/api/v3/tools" && url.searchParams.get("toolkit_slug") === "composio_search")
      return json({
        items: [
          {
            slug: "COMPOSIO_SEARCH_WEB",
            name: "Web search",
            description: "Search the web",
            input_parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          },
          { slug: "COMPOSIO_SEARCH_FLIGHTS", name: "Flights", description: "Find flights", input_parameters: {} },
        ],
      });
    if (path === "/api/v3/tools")
      return json({
        items: [
          {
            slug: "GOOGLECALENDAR_EVENTS_LIST",
            name: "List events",
            description: "List events",
            input_parameters: { type: "object", properties: { calendarId: { type: "string" } } },
          },
          {
            slug: "GOOGLECALENDAR_CREATE_EVENT",
            name: "Create event",
            description: "Create an event",
            input_parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
          },
        ],
      });
    if (path.startsWith("/api/v3/tools/execute/"))
      return json({ data: { events: [{ summary: "Dentist" }] }, successful: true });
    return json({ error: { message: "no" } }, 404);
  }) as typeof fetch;
  const service = new ComposioService({
    secrets,
    settings: { get: ((k: string) => store[k]) as never, set: (k, v) => void (store[k] = v) },
    emit: (e) => events.push(e),
    openUrl: async (url) => void opened.push(url),
    fetch: fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      if (opened.length && !opts.neverFinishes) active = true;
    },
  });
  return { service, secrets, store, events, opened, calls };
}

describe("ComposioService", () => {
  it("checks the key before keeping it", async () => {
    const { service, secrets, calls } = setup({ withKey: false });
    await service.setKey("  ck_new  ");
    expect(secrets.values.get(COMPOSIO_KEY)).toBe("ck_new");
    expect(calls[0]).toMatchObject({ path: "/api/v3/toolkits", key: "ck_new" });
  });

  it("says what to do when there is no key", async () => {
    const { service } = setup({ withKey: false });
    await expect(service.connect("gmail")).rejects.toThrow(NEEDS_KEY);
  });

  it("lists apps and marks the connected ones", async () => {
    const { service } = setup({ signedIn: true });
    const apps = await service.apps();
    expect(apps.find((a) => a.slug === "googlecalendar")).toMatchObject({
      connected: true,
      enabled: true,
      readOnly: false,
    });
    expect(apps.find((a) => a.slug === "gmail")?.connected).toBe(false);
  });

  it("signs in by name, opens the page and waits until the account is active", async () => {
    const { service, events, opened, calls } = setup();
    const reply = await service.connect("google calendar");
    expect(reply).toContain("Google Calendar is connected");
    expect(opened).toEqual(["https://connect.example/sign-in"]);
    expect(events.map((e) => e.state)).toEqual(["waiting", "done"]);
    const link = calls.find((c) => c.path.endsWith("/link"));
    expect(link?.body).toMatchObject({ auth_config_id: "ac_1", user_id: expect.stringMatching(/^murmur-/) });
  });

  it("gives up when the sign-in is never finished", async () => {
    const { service, events } = setup({ neverFinishes: true });
    await expect(service.connect("gmail")).rejects.toThrow(/wasn't finished/);
    expect(events.map((e) => e.state)).toEqual(["waiting", "failed"]);
  });
});

describe("ComposioHost", () => {
  const searchNames = ["composio.composio_search_web", "composio.composio_search_flights"];

  it("offers the connect tools and web search until an app is connected", async () => {
    const { service } = setup();
    const names = (await new ComposioHost(service).list()).map((s) => s.name);
    expect(names).toEqual(["connections.connect", "connections.list", ...searchNames]);
  });

  it("searches the web with Composio's search tool: no sign-in, no preview, and no account sent", async () => {
    const { service, calls } = setup();
    const host = new ComposioHost(service);
    const search = (await host.list()).find((s) => s.name === "composio.composio_search_web");
    expect(search?.effects).toEqual({ readOnly: true });
    const llm = new ScriptedLlm([
      { text: "", toolCalls: [toolCall("1", "composio.composio_search_web", { query: "weather in Tokyo" })] },
      { text: "It is sunny.", toolCalls: [] },
    ]);
    const ui = new ScriptedApprovalUi([]);
    const result = await runAgent("weather in Tokyo", llm, host, new ApprovalGate(ui));
    expect(result.status).toBe("done");
    expect(ui.shown).toHaveLength(0);
    const exec = calls.find((c) => c.path.includes("/tools/execute/COMPOSIO_SEARCH_WEB"));
    expect(exec?.body).toMatchObject({ arguments: { query: "weather in Tokyo" } });
    expect(exec?.body).not.toHaveProperty("connected_account_id");
  });

  it("offers no search without a Composio key, and none when it is switched off", async () => {
    const none = setup({ withKey: false });
    expect(await new ComposioHost(none.service).list()).toHaveLength(2);
    const off = setup();
    off.service.configure("composio_search", { enabled: false });
    expect((await new ComposioHost(off.service).list()).map((s) => s.name)).toEqual([
      "connections.connect",
      "connections.list",
    ]);
  });

  it("exposes a connected app's tools, gated by what they do, and runs them with the account", async () => {
    const { service, calls } = setup({ signedIn: true });
    const host = new ComposioHost(service);
    const specs = await host.list();
    const read = specs.find((s) => s.name === "composio.googlecalendar_events_list");
    const write = specs.find((s) => s.name === "composio.googlecalendar_create_event");
    expect(read?.effects).toEqual({ readOnly: true });
    expect(write?.effects?.modifies).toBe(true);
    const out = await host.call("composio.googlecalendar_events_list", { calendarId: "primary" });
    expect(out).toContain("Dentist");
    const exec = calls.find((c) => c.path.includes("/tools/execute/"));
    expect(exec?.path).toContain("GOOGLECALENDAR_EVENTS_LIST");
    expect(exec?.body).toMatchObject({ connected_account_id: "ca_1", arguments: { calendarId: "primary" } });
  });

  it("hides tools that change things when an app is read-only, and hides the app when switched off", async () => {
    const { service } = setup({ signedIn: true });
    const host = new ComposioHost(service);
    service.configure("googlecalendar", { readOnly: true });
    expect((await host.list()).map((s) => s.name)).toContain("composio.googlecalendar_events_list");
    expect((await host.list()).map((s) => s.name)).not.toContain("composio.googlecalendar_create_event");
    service.configure("googlecalendar", { enabled: false });
    expect((await host.list()).map((s) => s.name)).toEqual(["connections.connect", "connections.list", ...searchNames]);
  });

  it("lets the agent connect an app mid-task and then use its tools", async () => {
    const { service } = setup();
    const host = new ComposioHost(service);
    const llm = new ScriptedLlm([
      { text: "", toolCalls: [toolCall("1", "connections.connect", { app: "Google Calendar" })] },
      { text: "", toolCalls: [toolCall("2", "composio.googlecalendar_events_list", {})] },
      { text: "You have a dentist visit.", toolCalls: [] },
    ]);
    const ui = new ScriptedApprovalUi([{ decision: "approve" }]);
    const result = await runAgent("what's on my calendar", llm, host, new ApprovalGate(ui));
    expect(result.status).toBe("done");
    expect(ui.shown).toHaveLength(1);
    expect(ui.shown[0]?.summary).toContain("Google Calendar");
    expect(result.trace.map((t) => t.tool)).toEqual(["connections.connect", "composio.googlecalendar_events_list"]);
    expect(result.trace[1]?.isError).toBe(false);
  });
});
