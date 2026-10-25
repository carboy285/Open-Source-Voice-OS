import { describe, expect, it, vi } from "vitest";
import { appKind } from "../src/core/context.js";
import { readFocusedText } from "../src/app/macos.js";
import { parseStoredHistory, ResultHistory } from "../src/app/history.js";
import { parseAppConfig, configToEnv } from "../src/app/appConfig.js";
import { runAgent } from "../src/modes/agent.js";
import { editSelection } from "../src/modes/edit.js";
import { dictate } from "../src/modes/dictation.js";
import { MemoryInjector } from "../src/providers/injectors.js";
import { BuiltinToolHost, dateParts, parseHttpUrl, searchUrl, type Exec } from "../src/tools/builtin.js";
import { CompositeToolHost } from "../src/tools/composite.js";
import type { LlmProvider, ToolHost } from "../src/core/types.js";

const fixedNow = () => new Date(2026, 9, 24, 15, 30);

describe("BuiltinToolHost", () => {
  const setup = (output = "") => {
    const exec = vi.fn<Exec>(async () => output);
    return { exec, host: new BuiltinToolHost(exec, fixedNow) };
  };

  it("only lets read-only tools run unasked, and asks before anything private or changing", async () => {
    const specs = await setup().host.list();
    const readOnly = specs.filter(spec => spec.readOnly).map(spec => spec.name).sort();
    expect(readOnly).toEqual(["get_datetime", "search_files"]);
    expect(specs.find(spec => spec.name === "clipboard_read")?.readOnly).toBe(false);
    expect(specs.find(spec => spec.name === "send_message")?.readOnly).toBe(false);
  });

  it("describes inputs as plain JSON schema", async () => {
    const reminder = (await setup().host.list()).find(spec => spec.name === "create_reminder")!;
    expect(reminder.inputSchema).toMatchObject({ type: "object", required: ["title"] });
    expect(reminder.inputSchema).not.toHaveProperty("$schema");
  });

  it("passes user text to AppleScript as arguments, never inside the script", async () => {
    const { host, exec } = setup();
    const hostile = 'x" & (do shell script "rm -rf ~") & "';
    await host.call("create_note", { title: hostile, body: "a < b" });
    const [command, args] = exec.mock.calls[0]!;
    expect(command).toBe("osascript");
    expect(args[1]).not.toContain("rm -rf");
    expect(args.slice(2)).toEqual([hostile, "<h1>x\" &amp; (do shell script \"rm -rf ~\") &amp; \"</h1><div>a &lt; b</div>"]);
  });

  it("builds reminder and event dates from validated numbers", async () => {
    const { host, exec } = setup();
    await host.call("create_reminder", { title: "Call Sam", due: "2026-10-25T09:05" });
    expect(exec.mock.calls[0]![1].slice(2)).toEqual(["Call Sam", "", "2026", "10", "25", "9", "5"]);
    await host.call("create_event", { title: "Lunch", start: "2026-11-02T12:00", durationMinutes: 45 });
    expect(exec.mock.calls[1]![1].slice(2)).toEqual(["Lunch", "", "45", "2026", "11", "2", "12", "0"]);
    expect(() => dateParts("2026-02-31T10:00")).toThrow("not a real date");
  });

  it("rejects bad input with a readable message", async () => {
    const { host, exec } = setup();
    await expect(host.call("create_reminder", { title: "", due: "tomorrow" })).rejects.toThrow(/Invalid input for create_reminder/);
    await expect(host.call("open_app", { name: "Safari; rm -rf /" })).rejects.toThrow(/Invalid input/);
    await expect(host.call("nope", {})).rejects.toThrow("Unknown tool");
    expect(exec).not.toHaveBeenCalled();
  });

  it("opens only web links", async () => {
    const { host, exec } = setup();
    await host.call("open_url", { url: "https://example.com/a b" });
    expect(exec).toHaveBeenCalledWith("open", ["https://example.com/a%20b"]);
    await expect(host.call("open_url", { url: "file:///etc/passwd" })).rejects.toThrow("Only http and https");
    expect(() => parseHttpUrl("javascript:alert(1)")).toThrow();
    await host.call("web_search", { query: "a&b c" });
    expect(exec).toHaveBeenLastCalledWith("open", [searchUrl("a&b c")]);
    expect(searchUrl("a&b c")).toBe("https://duckduckgo.com/?q=a%26b%20c");
  });

  it("drafts mail with every recipient and never sends", async () => {
    const { host, exec } = setup();
    const result = await host.call("draft_email", { to: ["a@x.com", "b@x.com"], subject: "Hi", body: "Body" });
    expect(exec.mock.calls[0]![1].slice(2)).toEqual(["Hi", "Body", "a@x.com", "b@x.com"]);
    expect(exec.mock.calls[0]![1][1]).not.toMatch(/\bsend\b/);
    expect(result).toContain("not been sent");
  });

  it("searches files with a cap, skipping Library paths", async () => {
    const lines = ["/Users/me/Library/x", "/Users/me/app/node_modules/f/y", "/Users/me/.cache/z", ...Array.from({ length: 30 }, (_, i) => `/Users/me/f${i}.txt`)].join("\n");
    const { host, exec } = setup(lines);
    const out = (await host.call("search_files", { query: "f", folder: "/Users/me" })).split("\n");
    expect(exec).toHaveBeenCalledWith("mdfind", ["-onlyin", "/Users/me", "-name", "f"]);
    expect(out).toHaveLength(20);
    expect(out.join()).not.toMatch(/Library|node_modules|\.cache/);
  });

  it("reports the current time in local form", async () => {
    expect(await setup().host.call("get_datetime", {})).toMatch(/^2026-10-24T15:30 \(Saturday, /);
  });
});

describe("CompositeToolHost", () => {
  const host = (name: string, closed: string[]): ToolHost => ({
    list: async () => [{ name, description: "", inputSchema: {}, readOnly: true }],
    call: async () => `from ${name}`,
    close: async () => { closed.push(name); },
  });
  it("routes by tool name and closes every host", async () => {
    const closed: string[] = [];
    const both = new CompositeToolHost([host("a", closed), host("b", closed)]);
    expect((await both.list()).map(spec => spec.name)).toEqual(["a", "b"]);
    expect(await both.call("b", {})).toBe("from b");
    await expect(both.call("c", {})).rejects.toThrow("Unknown tool");
    await both.close();
    expect(closed).toEqual(["a", "b"]);
  });
});

describe("screen context", () => {
  it("guesses the kind of app", () => {
    expect([appKind("Mail"), appKind("Slack"), appKind("Cursor"), appKind("Notes"), appKind("Calculator"), appKind(undefined)])
      .toEqual(["email", "chat", "code", "document", undefined, undefined]);
  });

  it("reads the end of the focused field but never a password field", async () => {
    expect(await readFocusedText(async () => "Mail\nok\nhello world")).toEqual({ app: "Mail", text: "hello world" });
    expect((await readFocusedText(async () => "Mail\nok\n" + "x".repeat(50), 10))?.text).toBe("x".repeat(10));
    expect(await readFocusedText(async () => "Safari\nsecure\n")).toBeUndefined();
    expect(await readFocusedText(async () => { throw new Error("denied"); })).toBeUndefined();
  });

  it("gives the model the context for edits, polish and the agent", async () => {
    const seen: string[] = [];
    const llm: LlmProvider = { complete: async request => { seen.push(request.messages.map(m => "text" in m ? m.text : "").join("\n")); return { text: "ok", toolCalls: [] }; } };
    const context = { appName: "Mail", kind: "email", screenText: "Hi Priya, thanks for the notes." };
    await editSelection("shorter", new MemoryInjector("x", "long text"), llm, context);
    await dictate("sounds good", new MemoryInjector(), context, { mode: "polished", polish: llm });
    await runAgent("hello", llm, { list: async () => [], call: async () => "" }, async () => true, { context, now: fixedNow });
    expect(seen[0]).toContain("App: Mail (email)");
    expect(seen[0]).toContain("Hi Priya");
    expect(seen[1]).toContain("Hi Priya");
    expect(seen[2]).toContain("Frontmost app: Mail (email)");
    expect(seen[2]).toContain("Current date and time: Sat Oct 24 2026 15:30");
  });
});

describe("language and history settings", () => {
  it("defaults to auto language, memory-only history, and no screen sharing", () => {
    const config = parseAppConfig(undefined);
    expect(config).toMatchObject({ language: "auto", historyPersist: false, screenContext: false, builtinTools: true });
    expect(configToEnv(parseAppConfig('{"language":"ES"}'))["WHISPER_LANGUAGE"]).toBe("es");
    expect(() => parseAppConfig('{"language":"english please"}')).toThrow();
  });

  it("restores only well-formed saved results within the limit", () => {
    const good = { id: "a", at: 1, mode: "dictate", transcript: "t", text: "x", status: "inserted" };
    expect(parseStoredHistory(JSON.stringify([good]))).toEqual([good]);
    expect(parseStoredHistory(JSON.stringify([{ ...good, mode: "bogus" }]))).toEqual([]);
    expect(parseStoredHistory("not json")).toEqual([]);
    const history = new ResultHistory(true, 2);
    history.restore([good, { ...good, id: "b" }, { ...good, id: "c" }] as never);
    expect(history.list().map(entry => entry.id)).toEqual(["a", "b"]);
  });
});
