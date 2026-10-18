import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPrompt, CodexCliLlm, parseResponse, spawnCodex } from "../src/providers/codex.js";

const ids = () => {
  let n = 0;
  return () => `id${++n}`;
};

describe("parseResponse", () => {
  it("parses tool calls and their JSON-string input", () => {
    const raw = JSON.stringify({ text: "", tool_calls: [{ name: "a__b", input_json: '{"x":1}' }] });
    expect(parseResponse(raw, ids())).toEqual({ text: "", toolCalls: [{ id: "id1", name: "a__b", input: { x: 1 } }] });
  });

  it("accepts a fenced JSON reply", () => {
    expect(parseResponse('```json\n{"text":"hi","tool_calls":[]}\n```', ids()).text).toBe("hi");
  });

  it("falls back to plain text when the model ignores the schema", () => {
    expect(parseResponse("just words", ids())).toEqual({ text: "just words", toolCalls: [] });
  });
});

describe("buildPrompt", () => {
  it("lists tools and the conversation", () => {
    const prompt = buildPrompt({
      system: "SYS",
      messages: [{ role: "user", text: "hello" }],
      tools: [{ name: "rea__open_binary", description: "Open", inputSchema: { type: "object" }, readOnly: false }],
    });
    expect(prompt).toContain("SYS");
    expect(prompt).toContain("rea__open_binary");
    expect(prompt).toContain("[user]\nhello");
  });
});

describe("CodexCliLlm", () => {
  it("runs codex ephemerally and read-only, never touching credentials", async () => {
    let seen: string[] = [];
    const llm = new CodexCliLlm({
      model: "gpt-x",
      runner: async (args, stdin) => {
        seen = args;
        expect(stdin).toContain("Conversation so far");
        const out = args[args.indexOf("-o") + 1]!;
        const { writeFileSync } = await import("node:fs");
        writeFileSync(out, '{"text":"done","tool_calls":[]}');
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const response = await llm.complete({ system: "s", messages: [{ role: "user", text: "hi" }] });
    expect(response.text).toBe("done");
    expect(seen).toEqual(expect.arrayContaining(["exec", "--ephemeral", "--ignore-user-config", "read-only", "-m", "gpt-x"]));
    expect(seen.join(" ")).not.toMatch(/auth|token|key/i);
  });

  it("explains how to sign in when codex fails", async () => {
    const llm = new CodexCliLlm({ runner: async () => ({ code: 1, stdout: "", stderr: "not logged in" }) });
    await expect(llm.complete({ system: "s", messages: [] })).rejects.toThrow(/voiceos login/);
  });

  it("works against a real process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
    const script = resolve("tests/fixtures/fake-codex.sh");
    chmodSync(script, 0o755);
    process.env["FAKE_CODEX_STDIN"] = join(dir, "stdin");
    process.env["FAKE_CODEX_REPLY"] = '{"text":"","tool_calls":[{"name":"s__t","input_json":"{}"}]}';
    const llm = new CodexCliLlm({ runner: spawnCodex(script) });
    const response = await llm.complete({ system: "s", messages: [{ role: "user", text: "go" }] });
    expect(response.toolCalls[0]?.name).toBe("s__t");
    expect(readFileSync(join(dir, "stdin"), "utf8")).toContain("[user]\ngo");
  });

  it("gives up when codex hangs", async () => {
    const llm = new CodexCliLlm({ runner: spawnCodex(resolve("tests/fixtures/slow-codex.sh"), 300) });
    await expect(llm.complete({ system: "s", messages: [] })).rejects.toThrow(/did not answer/);
  });

  it("reports a missing codex binary", async () => {
    const llm = new CodexCliLlm({ runner: spawnCodex("definitely-not-codex-binary") });
    await expect(llm.complete({ system: "s", messages: [] })).rejects.toThrow(/Install Codex/);
  });
});
