import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SttProvider } from "../core/types.js";

const run = promisify(execFile);

/** Local speech-to-text through a whisper.cpp command-line build (`whisper-cli`). Audio never leaves the machine. */
export class WhisperCppStt implements SttProvider {
  constructor(
    private readonly modelPath: string,
    private readonly binary = "whisper-cli",
    private readonly language = "auto",
  ) {}

  async transcribe(audioPath: string): Promise<string> {
    // -nt: no timestamps, so stdout is only the transcript.
    const { stdout } = await run(
      this.binary,
      ["-m", this.modelPath, "-f", audioPath, "-l", this.language, "-nt"],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.replace(/\s+/g, " ").trim();
  }
}
