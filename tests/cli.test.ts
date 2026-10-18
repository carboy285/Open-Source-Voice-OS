import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function cli(args: string[], input = "", env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli/main.ts"), ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.on("error", reject);
    child.stdin.end(input);
  });
}

describe("CLI", () => {
  it.each([[], ["--help"], ["-h"], ["help"], ["dictate", "--help"]].map((args) => ({ args })))("prints help successfully for $args", async ({ args }) => {
    const result = await cli(args);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("voiceos <command>");
    expect(result.stderr).toBe("");
  });

  it("rejects an unknown command with usage", async () => {
    const result = await cli(["typo"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown command");
  });

  it("reads piped text when explicitly requested", async () => {
    const result = await cli(["dictate", "--stdin"], "um hello\nworld");
    expect(result).toEqual({ code: 0, stdout: "Hello\nWorld\n", stderr: "" });
  });

  it("rejects ambiguous transcript sources", async () => {
    const result = await cli(["dictate", "--text", "hello", "--audio", "missing.wav"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("exactly one");
  });

  it("rejects empty piped input before starting a model", async () => {
    const result = await cli(["agent", "--stdin"], " \n");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("empty");
  });

  it("loads vocabulary from a JSON file for piped dictation", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "voiceos-vocabulary-"));
    try {
      const file = resolve(dir, "vocabulary.json");
      await writeFile(file, JSON.stringify({ "eye oh ess": "iOS", "git hub": "GitHub" }));
      const result = await cli(["dictate", "--stdin", "--vocabulary", file], "eye oh ess uses git hub");
      expect(result).toEqual({ code: 0, stdout: "iOS uses GitHub.\n", stderr: "" });
      await writeFile(file, JSON.stringify({ word: 42 }));
      expect((await cli(["dictate", "--text", "word", "--vocabulary", file])).code).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("denies side-effecting agent tools when stdin is a pipe, unless --yes is explicit", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "voiceos-cli-agent-"));
    try {
      const config = resolve(dir, "mcp.json");
      const prompt = resolve(dir, "prompt.txt");
      await writeFile(config, JSON.stringify({ servers: {
        fx: { command: process.execPath, args: [resolve("tests/fixtures/mcp-server.mjs")] },
      } }));
      const env = {
        VOICEOS_LLM: "codex",
        VOICEOS_CODEX_BIN: resolve("tests/fixtures/fake-codex.sh"),
        FAKE_CODEX_REPLY: JSON.stringify({ text: "", tool_calls: [{ name: "fx__send", input_json: '{"to":"test"}' }] }),
        FAKE_CODEX_STDIN: prompt,
      };
      const denied = await cli(["agent", "--stdin", "--mcp", config], "send a message", env);
      expect(denied.code).toBe(0);
      expect(denied.stderr).toContain("action denied");
      expect(await readFile(prompt, "utf8")).toContain("The user declined this action.");
      const allowed = await cli(["agent", "--stdin", "--mcp", config, "--yes"], "send a message", env);
      expect(allowed.code).toBe(0);
      expect(allowed.stderr).toBe("");
      expect(await readFile(prompt, "utf8")).toContain("sent to test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
