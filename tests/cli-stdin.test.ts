import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeWav } from "../src/cli/audio.js";
import { wav } from "../src/providers/whisper-cpp.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function cli(args: string[], input = "", tty = false) {
  const dir = await mkdtemp(join(tmpdir(), "murmur-cli-"));
  dirs.push(dir);
  const imports = ["--import", "tsx"];
  if (tty) imports.push("--import", "data:text/javascript,Object.defineProperty(process.stdin,'isTTY',{value:true})");
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, [...imports, resolve("src/cli/main.ts"), ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MURMUR_HOME: dir },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}

describe("CLI transcript sources", () => {
  it("dictates piped text using the current dictation pipeline", async () => {
    const result = await cli(["dictate", "--stdin"], "um so the the meeting is at noon");
    expect(result).toEqual({ code: 0, stdout: "So the meeting is at noon.\n", stderr: "" });
  });

  it("still accepts explicit text", async () => {
    expect((await cli(["dictate", "--text", "hello"])).stdout).toBe("Hello.\n");
  });

  it("accepts piped agent input before checking model configuration", async () => {
    const result = await cli(["agent", "--stdin"], "what reminders do I have");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Settings");
    expect(result.stderr).not.toContain("input transcript is empty");
    expect(result.stderr).not.toContain("exactly one");
  });

  it("preserves the existing clean command", async () => {
    const result = await cli(["clean", "um hello there"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Hello there.\n");
  });

  it.each(["dictate", "agent"])("rejects empty piped input for %s", async (command) => {
    const result = await cli([command, "--stdin"], " \n\t");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("input transcript is empty");
  });

  it.each(["dictate", "agent"])("rejects a TTY for %s --stdin", async (command) => {
    const result = await cli([command, "--stdin"], "hello", true);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Use --text");
  });

  it.each(["dictate", "agent"])("requires exactly one source for %s", async (command) => {
    for (const args of [
      [],
      ["--text", "hello", "--stdin"],
      ["--audio", "missing.wav", "--stdin"],
      ["--text", "hello", "--audio", "missing.wav"],
      ["--text", "hello", "--audio", "missing.wav", "--stdin"],
    ]) {
      const result = await cli([command, ...args], "hello");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("exactly one of --text, --audio, or --stdin");
    }
  });

  it("documents stdin in command help", async () => {
    const result = await cli(["dictate", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("murmur dictate --text <text> | --audio <file.wav> | --stdin");
    expect(result.stdout).toContain("murmur agent --text <request> | --audio <file.wav> | --stdin");
  });
});

describe("CLI audio input", () => {
  it("decodes PCM16 WAV data in memory", () => {
    const pcm = Uint8Array.from([1, 2, 3, 4]);
    const result = decodeWav(wav({ pcm, sampleRate: 16000 }));
    expect(result.sampleRate).toBe(16000);
    expect(result.pcm).toEqual(Buffer.from(pcm));
  });

  it("rejects malformed or unsupported audio", () => {
    expect(() => decodeWav(Buffer.from("not a WAV"))).toThrow("mono 16 kHz PCM16 WAV");
    expect(() => decodeWav(wav({ pcm: new Uint8Array(2), sampleRate: 48000 }))).toThrow();
    expect(() => decodeWav(wav({ pcm: new Uint8Array(2), sampleRate: 16000 }).subarray(0, 44))).toThrow();
  });
});
