import { spawn } from "node:child_process";
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

/**
 * Local speech-to-text with whisper.cpp. Audio goes to the process on stdin ("-f -"),
 * so nothing is written to disk.
 */
export class WhisperCppStt implements SttProvider {
  constructor(private readonly options: WhisperCppOptions) {}

  args(options: TranscribeOptions = {}): string[] {
    const args = ["-m", this.options.model, "-f", "-", "-nt", "-np", "-l", options.language ?? "auto"];
    if (this.options.threads) args.push("-t", String(this.options.threads));
    if (options.prompt) args.push("--prompt", options.prompt);
    return args;
  }

  transcribe(audio: Pcm16Audio, options: TranscribeOptions = {}): Promise<Transcript> {
    if (!this.options.model) return Promise.reject(new Error("Choose a whisper model file in Settings › Speech."));
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.binary, this.args(options), { stdio: ["pipe", "pipe", "pipe"] });
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
        reject(new Error(`Could not start ${this.options.binary}: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0)
          return reject(new Error(`whisper exited with code ${code}: ${stderr.trim().split("\n").pop() ?? ""}`));
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
