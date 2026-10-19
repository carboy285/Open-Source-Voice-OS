import { describe, expect, it } from "vitest";
import type { NativeCall } from "../src/connectors/apple.js";
import { checkTarget, computerConnector } from "../src/connectors/computer.js";
import { ConnectorRegistry, MemoryRegistryState } from "../src/connectors/registry.js";
import { buildCard } from "../src/gate/card.js";
import { classify } from "../src/gate/classify.js";
import { context } from "./fakes/connectors.js";

const HOME = "/Users/sam";
const there =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

describe("checkTarget", () => {
  const exists = there(
    "/Users/sam/Documents/report.pdf",
    "/Users/sam/run.command",
    "/Users/sam/x.sh",
    "/Users/sam/Downloads/Thing.app",
    "/Applications/Notes.app",
  );

  it("accepts web and email links and files that exist, with ~ spelled out", () => {
    expect(checkTarget("https://example.com/a b", HOME, exists)).toEqual({
      kind: "url",
      url: "https://example.com/a%20b",
    });
    expect(checkTarget("mailto:a@b.co", HOME, exists)).toMatchObject({ kind: "url" });
    expect(checkTarget("~/Documents/report.pdf", HOME, exists)).toEqual({
      kind: "path",
      path: "/Users/sam/Documents/report.pdf",
    });
    expect(checkTarget("/Applications/Notes.app", HOME, exists)).toMatchObject({ kind: "path" });
  });

  it("refuses anything that could run code, odd links, relative paths and missing files", () => {
    for (const bad of [
      "",
      "   ",
      "report.pdf",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ssh://host",
      "/Users/sam/nope.txt",
    ]) {
      expect(() => checkTarget(bad, HOME, exists), bad).toThrow();
    }
    expect(() => checkTarget("/Users/sam/run.command", HOME, exists)).toThrow(/can run it/);
    expect(() => checkTarget("/Users/sam/x.sh", HOME, exists)).toThrow(/can run it/);
    expect(() => checkTarget("/Users/sam/Downloads/Thing.app", HOME, exists)).toThrow(/by name/);
  });
});

function setup(
  options: { platform?: NodeJS.Platform; reply?: (action: string, args: Record<string, unknown>) => unknown } = {},
) {
  const ran: Array<[string, string[]]> = [];
  const calls: Array<{ service: string; action: string; args: Record<string, unknown> }> = [];
  const native: NativeCall = async (service, action, args) => {
    calls.push({ service, action, args });
    return options.reply?.(action, args) ?? {};
  };
  const connector = computerConnector({
    native: options.platform === "linux" ? undefined : native,
    run: async (file, args) => {
      ran.push([file, args]);
      return file === "mdfind"
        ? "/Users/sam/Documents/Tax 2025.pdf\n/Users/sam/Library/Caches/x.pdf\n/Users/sam/.hidden/y.pdf\n"
        : "";
    },
    platform: options.platform ?? "darwin",
    home: HOME,
    exists: there("/Users/sam/Documents/Tax 2025.pdf"),
  });
  const registry = new ConnectorRegistry(new MemoryRegistryState(new Set(["computer"])), () => context()).register(
    connector,
  );
  return { connector, registry, ran, calls };
}

describe("Computer connector", () => {
  it("reads and looks without asking, and gates everything that acts", async () => {
    const { registry } = setup();
    const gated = Object.fromEntries((await registry.list()).map((s) => [s.name, classify(s).gated]));
    expect(gated).toEqual({
      "computer.open": true,
      "computer.find_files": false,
      "computer.open_app": true,
      "computer.apps": false,
      "computer.quit_app": true,
      "computer.read_screen": false,
      "computer.click": true,
      "computer.type": true,
      "computer.press_keys": true,
      "computer.choose_menu": true,
    });
  });

  it("offers only opening on Windows, and nothing that needs the Mac app without it", () => {
    const names = (platform: NodeJS.Platform, native: boolean) =>
      computerConnector({ platform, native: native ? async () => ({}) : undefined }).actions.map((a) => a.name);
    expect(names("win32", false)).toEqual(["open"]);
    expect(names("darwin", false)).toEqual(["open", "find_files", "open_app"]);
    expect(names("darwin", true)).toHaveLength(10);
  });

  it("finds files with Spotlight and leaves out library and hidden folders", async () => {
    const { connector, ran } = setup();
    const find = connector.actions.find((a) => a.name === "find_files")!;
    const out = await find.run({ name: "Tax" }, context());
    expect(out).toBe("/Users/sam/Documents/Tax 2025.pdf");
    expect(ran[0]).toEqual(["mdfind", ["-onlyin", HOME, "-name", "Tax"]]);
  });

  it("opens files, reveals them, and opens links, with no shell involved", async () => {
    const { connector, ran } = setup();
    const open = connector.actions.find((a) => a.name === "open")!;
    await open.run({ target: "/Users/sam/Documents/Tax 2025.pdf" }, context());
    await open.run({ target: "/Users/sam/Documents/Tax 2025.pdf", show_in_finder: true }, context());
    await open.run({ target: "https://example.com" }, context());
    expect(ran).toEqual([
      ["open", ["--", "/Users/sam/Documents/Tax 2025.pdf"]],
      ["open", ["-R", "--", "/Users/sam/Documents/Tax 2025.pdf"]],
      ["open", ["--", "https://example.com/"]],
    ]);
    await expect(open.run({ target: "/Users/sam/x.sh" }, context())).rejects.toThrow();
    expect(ran).toHaveLength(3);
  });

  it("opens an app by name and refuses a name that looks like an option or a path", async () => {
    const { connector, ran } = setup();
    const openApp = connector.actions.find((a) => a.name === "open_app")!;
    await openApp.run({ app: "Spotify" }, context());
    expect(ran).toEqual([["open", ["-a", "Spotify"]]]);
    for (const app of ["-g", "/bin/sh", "a\\b"]) await expect(openApp.run({ app }, context())).rejects.toThrow();
  });

  it("describes a click by what Murmur saw on the screen, not by what the model says", async () => {
    const { connector, calls } = setup({
      reply: (action) =>
        action === "ui_read"
          ? {
              app: "Mail",
              window: "Inbox",
              menus: ["Mail", "File"],
              items: [
                { id: "e1", role: "AXButton", label: "Get Mail" },
                { id: "e2", role: "AXSearchField", label: "Search", value: "tax" },
                { id: "e3", role: "AXTextField", label: "Password", secure: true },
                { id: "e4", role: "AXStaticText", label: "3 unread" },
              ],
            }
          : { ok: true },
    });
    const read = connector.actions.find((a) => a.name === "read_screen")!;
    const click = connector.actions.find((a) => a.name === "click")!;
    const type = connector.actions.find((a) => a.name === "type")!;
    const ctx = context();

    // Nothing was read yet, so there is nothing to click.
    await expect(click.run({ id: "e1" }, ctx)).rejects.toThrow(/read_screen/);
    expect(click.summarize({ id: "e1" }, ctx)).toMatch(/wasn't on the last look/);

    const text = await read.run({}, ctx);
    expect(text).toContain('e1 button "Get Mail"');
    expect(text).toContain('e2 search field "Search" (contains "tax")');
    expect(text).toContain("password field, hidden");
    expect(text).toContain("Menus: Mail, File");

    expect(click.summarize({ id: "e1" }, ctx)).toBe('Click the button "Get Mail" in Mail');
    await click.run({ id: "e1" }, ctx);
    expect(calls.at(-1)).toEqual({
      service: "computer",
      action: "ui_click",
      args: { id: "e1", role: "AXButton", label: "Get Mail" },
    });

    expect(type.summarize({ app: "Mail", text: "hello", id: "e2" }, ctx)).toBe(
      'Type "hello" into the search field "Search" in Mail',
    );
    await type.run({ app: "Mail", text: "hello", id: "e2" }, ctx);
    expect(calls.at(-1)?.args).toMatchObject({
      app: "Mail",
      text: "hello",
      id: "e2",
      role: "AXSearchField",
      label: "Search",
    });

    // Looking again forgets the old ids.
    await read.run({}, ctx);
    await expect(click.run({ id: "e9" }, ctx)).rejects.toThrow(/read_screen/);
  });

  it("quits, presses keys and chooses menus through the Mac app", async () => {
    const { connector, calls } = setup({ reply: (a) => (a === "quit" ? { name: "Spotify" } : {}) });
    const by = (n: string) => connector.actions.find((a) => a.name === n)!;
    const ctx = context();
    expect(await by("quit_app").run({ app: "spotify" }, ctx)).toBe("Quit Spotify.");
    expect(by("press_keys").summarize({ app: "Notes", keys: "cmd+s" }, ctx)).toBe("Press cmd+s in Notes");
    await by("press_keys").run({ app: "Notes", keys: "cmd+s" }, ctx);
    expect(by("choose_menu").summarize({ app: "Notes", path: ["File", "New Note"] }, ctx)).toBe(
      "Choose File ▸ New Note in Notes",
    );
    await by("choose_menu").run({ app: "Notes", path: ["File", "New Note"] }, ctx);
    expect(calls.map((c) => c.action)).toEqual(["quit", "ui_key", "menu"]);
    await expect(by("choose_menu").run({ app: "Notes", path: [] }, ctx)).rejects.toThrow();
  });
});

describe("computer cards", () => {
  it("shows a Computer card with the sentence as its title and no item ids", () => {
    const card = buildCard(
      { name: "computer.click", icon: "computer", app: "Computer" },
      { id: "e12" },
      'Click the button "Send" in Mail',
      { now: 0, timeZone: "UTC", locale: "en-US" },
    );
    expect(card.kind).toBe("computer");
    expect(card.title).toBe('Click the button "Send" in Mail');
    expect(card.rows).toEqual([]);
  });
});
