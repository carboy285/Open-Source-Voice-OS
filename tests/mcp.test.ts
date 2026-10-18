import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classify } from "../src/gate/classify.js";
import { runMcpCli } from "../src/mcp/cli.js";
import { parseAddArgs, protectSecrets, resolveSecrets, UsageError } from "../src/mcp/config.js";
import { formatContent, McpManager, type McpConnection, type McpTool } from "../src/mcp/manager.js";
import { MemorySecretStore } from "../src/secrets/store.js";

describe("parseAddArgs", () => {
  it("parses a stdio server with env", () => {
    expect(parseAddArgs(["notes", "--env", "VAULT=/x", "--", "npx", "-y", "notes-mcp", "--flag"])).toEqual({
      name: "notes",
      server: { command: "npx", args: ["-y", "notes-mcp", "--flag"], env: { VAULT: "/x" }, enabled: true },
    });
  });

  it("parses an HTTP server with headers", () => {
    expect(
      parseAddArgs(["linear", "--url", "https://mcp.example.com/mcp", "--header", "Authorization=Bearer abc"]),
    ).toEqual({
      name: "linear",
      server: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer abc" }, enabled: true },
    });
  });

  it("rejects bad names, mixed modes and insecure URLs", () => {
    const bad = [
      ["Bad_Name", "--", "x"],
      ["a".repeat(33), "--", "x"],
      ["x", "--url", "https://a.example", "--", "cmd"],
      ["x", "--url", "http://example.com"],
      ["x"],
      ["x", "--env", "NOEQUALS", "--", "cmd"],
      ["x", "--header", "A=b", "--", "cmd"],
      ["x", "--url", "https://a.example", "--env", "A=b"],
    ];
    for (const argv of bad) expect(() => parseAddArgs(argv), argv.join(" ")).toThrow(UsageError);
    expect(parseAddArgs(["local", "--url", "http://localhost:3000/mcp"]).server).toMatchObject({
      url: "http://localhost:3000/mcp",
    });
  });
});

describe("secret handling", () => {
  it("moves secret-looking values to the keychain and resolves them back", async () => {
    const secrets = new MemorySecretStore();
    const stored = await protectSecrets(
      "gh",
      {
        command: "gh-mcp",
        args: [],
        env: { GITHUB_TOKEN: "ghp_x", API_KEY: "k", CLIENT_SECRET: "s", REGION: "eu" },
        enabled: true,
      },
      secrets,
    );
    expect(stored).toMatchObject({
      env: {
        GITHUB_TOKEN: "keychain:mcp/gh/env/GITHUB_TOKEN",
        API_KEY: "keychain:mcp/gh/env/API_KEY",
        CLIENT_SECRET: "keychain:mcp/gh/env/CLIENT_SECRET",
        REGION: "eu",
      },
    });
    expect(await resolveSecrets(stored, secrets)).toMatchObject({ env: { GITHUB_TOKEN: "ghp_x", REGION: "eu" } });
  });
});

describe("murmur add/list/remove mcp", () => {
  function deps() {
    const dir = mkdtempSync(join(tmpdir(), "murmur-mcp-"));
    const lines: string[] = [];
    const secrets = new MemorySecretStore();
    const factory = async (): Promise<McpConnection> =>
      fakeConnection([
        { name: "a", inputSchema: {} },
        { name: "b", inputSchema: {} },
      ]);
    return { configPath: join(dir, "mcp.json"), secrets, out: (l: string) => lines.push(l), lines, factory };
  }

  it("writes the config file without secrets, lists status and removes", async () => {
    const d = deps();
    expect(
      await runMcpCli(
        "add",
        ["remote", "--url", "https://mcp.example.com", "--header", "Authorization=Bearer s3cret"],
        d,
      ),
    ).toBe(0);
    expect(await runMcpCli("add", ["local", "--", "node", "server.js"], d)).toBe(0);
    const file = readFileSync(d.configPath, "utf8");
    expect(file).not.toContain("s3cret");
    expect(JSON.parse(file).servers.remote.headers.Authorization).toBe("keychain:mcp/remote/header/Authorization");
    expect(d.secrets.values.get("mcp/remote/header/Authorization")).toBe("Bearer s3cret");

    d.lines.length = 0;
    expect(await runMcpCli("list", [], d)).toBe(0);
    expect(d.lines.join("\n")).toMatch(/local\s+connected, 2 tools/);

    expect(await runMcpCli("remove", ["remote"], d)).toBe(0);
    expect(d.secrets.values.size).toBe(0);
    expect(JSON.parse(readFileSync(d.configPath, "utf8")).servers).not.toHaveProperty("remote");
    expect(await runMcpCli("remove", ["remote"], d)).toBe(1);
  });

  it("prints usage on bad input", async () => {
    const d = deps();
    expect(await runMcpCli("add", ["Bad Name"], d)).toBe(2);
    expect(d.lines[0]).toMatch(/not a valid name/);
  });
});

function fakeConnection(tools: McpTool[]): McpConnection & { changed?: () => void; closeHandler?: () => void } {
  const conn: McpConnection & { changed?: () => void; closeHandler?: () => void } = {
    listTools: async () => tools,
    callTool: async (name, args) => ({ content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }] }),
    onToolsChanged: (h) => (conn.changed = h),
    onClose: (h) => (conn.closeHandler = h),
    close: async () => {},
  };
  return conn;
}

describe("McpManager", () => {
  it("names tools mcp.<server>.<tool>, prefixes descriptions and gates by annotations", async () => {
    const manager = new McpManager({
      secrets: new MemorySecretStore(),
      factory: async () =>
        fakeConnection([
          { name: "read", description: "Reads", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          { name: "write", description: "Writes", inputSchema: { type: "object" } },
        ]),
    });
    await manager.start({ servers: { notes: { command: "x", args: [], env: {}, enabled: true } } });
    const tools = await manager.list();
    expect(tools.map((t) => [t.name, t.description, classify(t).gated])).toEqual([
      ["mcp.notes.read", "[notes] Reads", false],
      ["mcp.notes.write", "[notes] Writes", true],
    ]);
    expect(await manager.call("mcp.notes.read", { q: 1 })).toBe('read:{"q":1}');
    await manager.close();
  });

  it("reconnects with backoff after a failure", async () => {
    let attempts = 0;
    const manager = new McpManager({
      secrets: new MemorySecretStore(),
      minRetryMs: 5,
      factory: async () => {
        attempts++;
        if (attempts < 3) throw new Error("not yet");
        return fakeConnection([{ name: "t", inputSchema: {} }]);
      },
    });
    await manager.start({ servers: { flaky: { command: "x", args: [], env: {}, enabled: true } } });
    expect(manager.status()[0]).toMatchObject({ state: "error", error: "not yet" });
    await new Promise((r) => setTimeout(r, 60));
    expect(manager.status()[0]).toMatchObject({ state: "connected", tools: 1 });
    await manager.close();
  });

  it("formats content: text joined, other types named", () => {
    expect(formatContent([{ type: "text", text: "a" }, { type: "image" }, { type: "audio" }])).toBe(
      "a\n[image]\n[unsupported content]",
    );
  });

  it("talks to a real stdio server through the SDK", async () => {
    const manager = new McpManager({ secrets: new MemorySecretStore() });
    const script = join(import.meta.dirname, "fixtures", "echo-server.mjs");
    await manager.start({ servers: { echo: { command: process.execPath, args: [script], env: {}, enabled: true } } });
    expect(manager.status()[0]?.state).toBe("connected");
    const tools = await manager.list();
    expect(tools.map((t) => [t.name, classify(t).gated])).toEqual([
      ["mcp.echo.echo", false],
      ["mcp.echo.write", true],
    ]);
    expect(await manager.call("mcp.echo.echo", { text: "hi" })).toBe("echo: hi");
    expect(await manager.call("mcp.echo.write", { path: "/a" })).toBe("wrote /a\n[image]");
    await manager.close();
  }, 20_000);
});
