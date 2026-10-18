import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Pcm16Audio, SttProvider, TranscribeOptions, Transcript } from "../core/types.js";

export interface WhisperCppOptions {
  /** whisper.cpp CLI binary, e.g. "whisper-cli" or an absolute path. */
  binary: string;
  /** ggml model file. */
  model: string;
  threads?: number;
  timeoutMs?: number;
}

/** Wraps PCM16 mono in a WAV header, in memory. */
export function wav(audio: Pcm16Audio): Buffer {
  const header = Buffer.alloc(44);
  const dataLen = audio.pcm.byteLength;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(audio.sampleRate, 24);
  header.writeUInt32LE(audio.sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, Buffer.from(audio.pcm.buffer, audio.pcm.byteOffset, dataLen)]);
}

/** Folders searched for a bare binary name before PATH. Apps opened from Finder don't get Homebrew on PATH. */
export const BINARY_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves a bare name like "whisper-cli" to a full path. A value containing a slash is used as is. */
export function resolveBinary(
  name: string,
  envPath = process.env.PATH ?? "",
  exists: (path: string) => boolean = isExecutable,
): string {
  if (!name || name.includes("/") || name.includes("\\")) return name;
  const dirs = [...BINARY_DIRS, ...envPath.split(delimiter).filter(Boolean)];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return name;
}

/** whisper-cli builds that treat "-f -" as an output file print this and nothing else. */
const STDIN_IGNORED = /--output-file -'? used without any other/;

/**
 * Local speech-to-text with whisper.cpp. Audio goes to the process on stdin ("-f -"), so nothing is written to disk.
 * whisper-cli names its output after the input, and an output named "-" switches off the printed transcript
 * (1.9.5 prints only a warning). "-of" sets a harmless name; no file is written because no --output-* format is asked for.
 * "/dev/stdin" is not an option: the decoder needs to seek, which a pipe can't do.
 */
export class WhisperCppStt implements SttProvider {
  constructor(private readonly options: WhisperCppOptions) {}

  args(options: TranscribeOptions = {}): string[] {
    const args = ["-m", this.options.model, "-f", "-", "-of", "murmur", "-nt", "-np", "-l", options.language ?? "auto"];
    if (this.options.threads) args.push("-t", String(this.options.threads));
    if (options.prompt) args.push("--prompt", options.prompt);
    return args;
  }

  transcribe(audio: Pcm16Audio, options: TranscribeOptions = {}): Promise<Transcript> {
    if (!this.options.model) return Promise.reject(new Error("Choose a whisper model file in Settings › Speech."));
    return new Promise((resolve, reject) => {
      const binary = resolveBinary(this.options.binary);
      const child = spawn(binary, this.args(options), { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Speech recognition timed out."));
      }, this.options.timeoutMs ?? 30_000);
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", (error) => {
        clearTimeout(timer);
        const searched = binary === this.options.binary ? ` (looked in ${BINARY_DIRS.join(", ")} and PATH)` : "";
        reject(new Error(`Could not start ${this.options.binary}${searched}: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0)
          return reject(new Error(`whisper exited with code ${code}: ${stderr.trim().split("\n").pop() ?? ""}`));
        if (!stdout.trim() && STDIN_IGNORED.test(stderr))
          return reject(
            new Error(
              `${this.options.binary} printed no transcript: it did not read the audio from stdin. Update whisper.cpp or choose another whisper-cli.`,
            ),
          );
        resolve(parseWhisperOutput(stdout, stderr));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(wav(audio));
    });
  }
}

export function parseWhisperOutput(stdout: string, stderr: string): Transcript {
  const text = stdout
    .split("\n")
    .map((l) => l.replace(/^\[[^\]]*\]\s*/, "").trim())
    .filter((l) => l && !/^\[(BLANK_AUDIO|MUSIC|NOISE)\]$/i.test(l))
    .join(" ")
    .trim();
  const language = stderr.match(/auto-detected language:\s*([a-z]{2,3})/i)?.[1];
  return language ? { text, language } : { text };
}
