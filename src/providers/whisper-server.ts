import type { ChildProcess } from "node:child_process";
import type { Pcm16Audio, SttProvider, TranscribeOptions, Transcript } from "../core/types.js";
import { wav, padded } from "./whisper-cpp.js";
import { resolveBinary } from "./cli.js";

/** Optional persistent whisper.cpp server. Model stays loaded between recordings. */
export class WhisperServerStt implements SttProvider {
  private child?: ChildProcess;
  private starting?: Promise<string>;
  private lifetime = new AbortController();
  constructor(
    private modelPath: string,
    private binary = "whisper-server",
  ) {}

  close(): void {
    this.lifetime.abort();
    this.child?.kill("SIGKILL");
    this.child = undefined;
    this.starting = undefined;
    this.lifetime = new AbortController();
  }

  async transcribe(audio: Pcm16Audio, options: TranscribeOptions = {}): Promise<Transcript> {
    const combined = AbortSignal.any([
      this.lifetime.signal,
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(120_000),
    ]);
    try {
      combined.throwIfAborted();
      this.starting ??= this.start(combined);
      const url = await this.starting;
      combined.throwIfAborted();
      const bytes = wav(padded(audio));
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "recording.wav");
      form.set("response_format", "json");
      form.set("language", options.language ?? "auto");
      if (options.prompt) form.set("prompt", options.prompt);
      const response = await fetch(`${url}/inference`, { method: "POST", body: form, signal: combined });
      if (!response.ok) throw new Error(`Whisper server returned ${response.status}.`);
      const result = (await response.json()) as { text?: unknown };
      if (typeof result.text !== "string") throw new Error("Whisper server returned an invalid transcript.");
      return { text: result.text.trim() };
    } catch (error) {
      // Aborting HTTP alone leaves native inference running. Kill the owned server too.
      this.close();
      throw error;
    }
  }

  private async start(signal: AbortSignal): Promise<string> {
    if (!this.modelPath) throw new Error("Set whisperModel before using the persistent speech model.");
    const { createServer } = await import("node:net");
    const { spawn } = await import("node:child_process");
    const { randomUUID } = await import("node:crypto");
    const { setTimeout: delay } = await import("node:timers/promises");
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const chosen = address && typeof address === "object" ? address.port : 0;
        probe.close((error) => (error ? reject(error) : resolve(chosen)));
      });
    });
    signal.throwIfAborted();
    const route = `/voiceos-${randomUUID()}`;
    const url = `http://127.0.0.1:${port}${route}`;
    const child = spawn(
      resolveBinary(this.binary),
      ["-m", this.modelPath, "--host", "127.0.0.1", "--port", String(port), "--request-path", route, "-nc"],
      { stdio: "ignore" },
    );
    this.child = child;
    let failure: Error | undefined;
    child.once("error", (error) => {
      failure = new Error(`Could not start ${this.binary}: ${error.message}`);
    });
    child.once("exit", (code) => {
      failure = new Error(`Whisper server exited (${code}). Check the model path.`);
    });
    while (true) {
      signal.throwIfAborted();
      if (failure) throw failure;
      try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(500)]) });
        await response.body?.cancel();
        if (response.ok) return url;
      } catch {
        signal.throwIfAborted();
      }
      await delay(200, undefined, { signal });
    }
  }
}
