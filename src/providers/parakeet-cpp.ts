import type { Pcm16Audio, SttProvider, TranscribeOptions, Transcript } from "../core/types.js";
import { runCli } from "./cli.js";
import { padded, wav } from "./whisper-cpp.js";

export interface ParakeetCppOptions {
  /** whisper.cpp's parakeet-cli, e.g. "parakeet-cli" (shipped inside Murmur) or an absolute path. */
  binary: string;
  /** A ggml Parakeet model file, e.g. ggml-parakeet-tdt-0.6b-v3-q8_0.bin. */
  model: string;
  threads?: number;
  timeoutMs?: number;
}

/**
 * Local speech-to-text with NVIDIA Parakeet TDT, run by whisper.cpp's parakeet-cli. The audio goes
 * to the process on stdin, so nothing is written to disk. Parakeet v3 detects the language itself
 * (25 European languages); it takes no prompt, so dictionary words are applied after transcription.
 */
export class ParakeetCppStt implements SttProvider {
  constructor(private readonly options: ParakeetCppOptions) {}

  args(): string[] {
    const args = ["-m", this.options.model, "-np", "-f", "-"];
    if (this.options.threads) args.push("-t", String(this.options.threads));
    return args;
  }

  async transcribe(audio: Pcm16Audio, _options: TranscribeOptions = {}): Promise<Transcript> {
    if (!this.options.model) throw new Error("Download a speech model in Settings › Dictation.");
    const { code, stdout, stderr } = await runCli(
      this.options.binary,
      this.args(),
      wav(padded(audio)),
      this.options.timeoutMs ?? 30_000,
    );
    if (code !== 0) {
      const reason = stderr.trim().split("\n").filter(Boolean).pop() ?? "";
      throw new Error(`parakeet-cli exited with code ${code}: ${reason}`);
    }
    if (/error: unknown argument: \S+/.test(stderr))
      throw new Error(`parakeet-cli: ${stderr.match(/unknown argument: \S+/)![0]}`);
    return { text: parseParakeetOutput(stdout) };
  }
}

/** parakeet-cli prints the tokens as they decode, then a newline. */
export function parseParakeetOutput(stdout: string): string {
  return stdout.replace(/\s+/g, " ").trim();
}
