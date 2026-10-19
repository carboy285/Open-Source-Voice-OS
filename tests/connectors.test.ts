import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtinConnectors } from "../src/connectors/index.js";
import { authorizeUrl, createPkce, pkceChallenge, saveTokens } from "../src/connectors/oauth.js";
import { ConnectorRegistry, MemoryRegistryState } from "../src/connectors/registry.js";
import { gmailConnector } from "../src/connectors/skeletons/gmail.js";
import type { Connector, ConnectorContext } from "../src/connectors/types.js";
import { webConnector } from "../src/connectors/web.js";
import { classify } from "../src/gate/classify.js";
import { validate } from "../src/gate/schema.js";
import { MemoryReminderStore } from "../src/reminders/scheduler.js";
import { context, fakeFetch } from "./fakes/connectors.js";

const action = (c: Connector, name: string) => c.actions.find((a) => a.name === name)!;

describe("registry", () => {
  it("exposes tools only for enabled connectors and enforces enable on call", async () => {
    const state = new MemoryRegistryState();
    const registry = new ConnectorRegistry(state, () => context()).register(
      ...builtinConnectors(new MemoryReminderStore()),
    );
    expect(await registry.list()).toEqual([]);
    registry.enable("reminders");
    const names = (await registry.list()).map((t) => t.name);
    expect(names).toEqual(["reminders.create", "reminders.list", "reminders.cancel"]);
    registry.disable("reminders");
    await expect(registry.call("reminders.list", {})).rejects.toThrow(/turned off/);
    expect(registry.catalog()).toHaveLength(11);
  });

  it("validates input against the schema before running", async () => {
    const state = new MemoryRegistryState(new Set(["reminders"]));
    const registry = new ConnectorRegistry(state, () => context()).register(
      ...builtinConnectors(new MemoryReminderStore()),
    );
    await expect(registry.call("reminders.create", { text: "x" })).rejects.toThrow(/when is required/);
  });
});

describe("catalog metadata", () => {
  const all = builtinConnectors(new MemoryReminderStore());

  it("has complete metadata, valid schemas and summaries for every action", () => {
    const ctx = context();
    for (const c of all) {
      expect(c.id).toMatch(/^[a-z]+$/);
      expect(c.name && c.description && c.icon).toBeTruthy();
      for (const a of c.actions) {
        expect(a.inputSchema.type).toBe("object");
        expect(Object.keys(a.effects).length).toBeGreaterThan(0);
        const sample = Object.fromEntries(
          Object.entries((a.inputSchema.properties ?? {}) as Record<string, { type: string }>).map(([k, s]) => [
            k,
            s.type === "array" ? ["ana@example.com"] : s.type === "integer" ? 1 : "2026-10-19T15:00:00Z",
          ]),
        );
        expect(a.summarize(sample, ctx).length).toBeGreaterThan(3);
      }
    }
  });

  it("classifies actions as the catalog says", () => {
    const flags = Object.fromEntries(
      all.flatMap((c) =>
        c.actions.map((a) => [
          `${c.id}.${a.name}`,
          classify({ name: a.name, description: "", inputSchema: a.inputSchema, origin: "builtin", effects: a.effects })
            .gated,
        ]),
      ),
    );
    expect(flags).toMatchObject({
      "web.search": false,
      "web.fetch_page": false,
      "files.search": false,
      "files.metadata": false,
      "files.rename": true,
      "files.move": true,
      "obsidian.search_notes": false,
      "obsidian.create_note": true,
      "obsidian.append": true,
      "reminders.create": true,
      "reminders.list": false,
      "reminders.cancel": true,
      "gmail.search": false,
      "gmail.draft": true,
      "gmail.send": true,
      "calendar.create_event": true,
      "slack.post_message": true,
      "notion.create_page": true,
      "linear.create_issue": true,
      "drive.create_doc": true,
    });
  });
});

describe("files", () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "murmur-files-"));
    mkdirSync(join(root, "Reports"));
    writeFileSync(join(root, "Reports", "invoice-march.pdf"), "x");
    writeFileSync(join(root, "notes.txt"), "y");
    const files = builtinConnectors(new MemoryReminderStore()).find((c) => c.id === "files")!;
    return { root, files, ctx: context({ roots: [root] }) };
  }

  it("searches by name and reads metadata", async () => {
    const { root, files, ctx } = setup();
    expect(await action(files, "search").run({ query: "invoice" }, ctx)).toContain("invoice-march.pdf");
    const meta = JSON.parse(await action(files, "metadata").run({ path: join(root, "notes.txt") }, ctx));
    expect(meta).toMatchObject({ type: "file", bytes: 1 });
  });

  it("renames and moves inside the allowed folders only", async () => {
    const { root, files, ctx } = setup();
    await action(files, "rename").run({ path: join(root, "notes.txt"), newName: "todo.txt" }, ctx);
    expect(existsSync(join(root, "todo.txt"))).toBe(true);
    await action(files, "move").run({ path: join(root, "todo.txt"), destination: join(root, "Reports") }, ctx);
    expect(existsSync(join(root, "Reports", "todo.txt"))).toBe(true);
    await expect(action(files, "rename").run({ path: "/etc/hosts", newName: "x" }, ctx)).rejects.toThrow(/outside/);
    await expect(action(files, "rename").run({ path: join(root, "Reports"), newName: "../x" }, ctx)).rejects.toThrow(
      /slashes/,
    );
  });
});

describe("obsidian", () => {
  it("creates, appends, searches and reads notes inside the vault", async () => {
    const vault = mkdtempSync(join(tmpdir(), "murmur-vault-"));
    const obsidian = builtinConnectors(new MemoryReminderStore()).find((c) => c.id === "obsidian")!;
    const ctx = context({ vaultPath: vault });
    await action(obsidian, "create_note").run({ title: "Trip ideas", content: "Kyoto in spring" }, ctx);
    await expect(action(obsidian, "create_note").run({ title: "Trip ideas", content: "x" }, ctx)).rejects.toThrow(
      /exists/,
    );
    await action(obsidian, "append").run({ note: "Trip ideas", content: "Hokkaido in winter" }, ctx);
    expect(readFileSync(join(vault, "Trip ideas.md"), "utf8")).toBe("Kyoto in spring\nHokkaido in winter\n");
    expect(await action(obsidian, "search_notes").run({ query: "hokkaido" }, ctx)).toContain("Trip ideas.md");
    expect(await action(obsidian, "read_note").run({ note: "Trip ideas.md" }, ctx)).toContain("Kyoto");
    await expect(action(obsidian, "read_note").run({ note: "../../etc/passwd" }, ctx)).rejects.toThrow(/outside/);
  });

  it("asks for a vault when none is set", async () => {
    const obsidian = builtinConnectors(new MemoryReminderStore()).find((c) => c.id === "obsidian")!;
    await expect(action(obsidian, "search_notes").run({ query: "x" }, context())).rejects.toThrow(/vault/);
  });
});

describe("reminders connector", () => {
  it("shows the parsed time in the preview and creates the reminder", async () => {
    const store = new MemoryReminderStore();
    const reminders = builtinConnectors(store).find((c) => c.id === "reminders")!;
    const ctx = context(); // 4 pm in New York
    const create = action(reminders, "create");
    expect(create.summarize({ text: "call Ana", when: "at 3" }, ctx)).toBe('Remind "call Ana" at Mon, Oct 19, 3:00 PM');
    await create.run({ text: "call Ana", when: "at 3" }, ctx);
    expect(store.list("scheduled")[0]).toMatchObject({ text: "call Ana", tz: "America/New_York" });
    expect(await action(reminders, "list").run({}, ctx)).toContain("call Ana");
    await action(reminders, "cancel").run({ id: 1 }, ctx);
    expect(store.list("scheduled")).toEqual([]);
  });
});

describe("web search", () => {
  it("has no default backend or key", async () => {
    const web = webConnector();
    await expect(action(web, "search").run({ query: "murmur" }, context())).rejects.toThrow(
      /No search provider is set/,
    );
    await expect(action(web, "search").run({ query: "murmur" }, context({ backend: "brave" }))).rejects.toThrow(
      /API key/,
    );
  });

  it("uses a pluggable backend and strips HTML from pages", async () => {
    const backend = { search: async () => [{ title: "Murmur", url: "https://example.org", snippet: "Voice" }] };
    const web = webConnector({ custom: backend });
    expect(await action(web, "search").run({ query: "x" }, context({ backend: "custom" }))).toContain(
      "https://example.org",
    );
    const { fn } = fakeFetch(() => "<html><script>x()</script><p>Hello <b>there</b></p></html>");
    expect(await action(web, "fetch_page").run({ url: "https://example.org" }, context({}, { fetch: fn }))).toBe(
      "Hello there",
    );
    await expect(action(web, "fetch_page").run({ url: "file:///etc/passwd" }, context())).rejects.toThrow(/http/);
  });
});

describe("skeleton connectors", () => {
  it("call the official API with the stored token", async () => {
    const { fn, calls } = fakeFetch(() => ({ id: "msg1" }));
    const ctx: ConnectorContext = context({}, { fetch: fn });
    await saveTokens(ctx.secrets, "gmail", { accessToken: "tok" });
    const send = action(gmailConnector(), "send");
    const input = { to: ["ana@example.com"], subject: "Q3 numbers", body: "Attached." };
    expect(validate(send.inputSchema, input)).toEqual([]);
    expect(send.summarize(input, ctx)).toBe('Email to ana@example.com: "Q3 numbers"');
    expect(await send.run(input, ctx)).toBe("Sent (msg1).");
    expect(calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const raw = JSON.parse(String(calls[0]!.init!.body)).raw as string;
    expect(Buffer.from(raw, "base64url").toString()).toContain("To: ana@example.com");
  });

  it("asks the user to connect first when there is no token", async () => {
    await expect(action(gmailConnector(), "search").run({ query: "x" }, context())).rejects.toThrow(/Connect Gmail/);
  });
});

describe("OAuth PKCE", () => {
  it("matches the RFC 7636 example and builds the authorize URL", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    const pkce = createPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const url = new URL(
      authorizeUrl(
        {
          authorizeUrl: "https://auth.example.com/authorize",
          tokenUrl: "",
          clientId: "abc",
          scopes: ["a", "b"],
          redirectUri: "http://127.0.0.1:53682/",
        },
        pkce,
        "st",
      ),
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "abc",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      scope: "a b",
      state: "st",
      response_type: "code",
    });
  });
});
