import type { Pcm16Audio, SttProvider, TranscribeOptions, Transcript } from "../core/types.js";
import { describeError, redactSecrets } from "../core/redact.js";
import type { SttApi } from "./catalog.js";
import { padded, wav } from "./whisper-cpp.js";

export interface CloudSttOptions {
  api: SttApi;
  /** Full address of the transcription endpoint. */
  url: string;
  model: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const text = (v: unknown): string => (typeof v === "string" ? v : "");

const NVIDIA_LANGUAGES: Record<string, string> = {
  en: "en-US",
  es: "es-US",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-BR",
  ja: "ja-JP",
  ko: "ko-KR",
  zh: "zh-CN",
  nl: "nl-NL",
};
/** NVIDIA wants a region too ("en-US"). With no language pinned it is asked for English. */
export const nvidiaLanguage = (language?: string): string =>
  !language ? "en-US" : language.includes("-") ? language : (NVIDIA_LANGUAGES[language.toLowerCase()] ?? "en-US");

/**
 * Speech to text through a hosted service, with the user's own key. The recording is sent to that service as a WAV
 * file and kept nowhere else. OpenAI, Groq, Mistral and any server that copies OpenAI's address share one format;
 * Deepgram and ElevenLabs have their own.
 */
export class CloudStt implements SttProvider {
  constructor(private readonly options: CloudSttOptions) {}

  async transcribe(audio: Pcm16Audio, options: TranscribeOptions = {}): Promise<Transcript> {
    if (!this.options.url) throw new Error("Add the address of your speech server in Settings › Dictation.");
    const file = wav(padded(audio));
    const signal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    ]);
    const run =
      this.options.api === "deepgram"
        ? this.deepgram
        : this.options.api === "elevenlabs"
          ? this.elevenlabs
          : this.options.api === "nvidia"
            ? this.nvidia
            : this.openai;
    try {
      return await run.call(this, file, options, signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new Error(describeError(error));
    }
  }

  private async send(url: string, init: RequestInit, signal: AbortSignal): Promise<Json> {
    let res: Response;
    try {
      res = await (this.options.fetch ?? fetch)(url, { ...init, signal });
    } catch (error) {
      if (signal.aborted) throw new Error("The speech service took too long to answer.");
      throw new Error(`Couldn't reach the speech service: ${describeError(error)}`);
    }
    const raw = await res.text();
    let json: Json = {};
    try {
      json = raw ? (JSON.parse(raw) as Json) : {};
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error("The speech service didn't accept the key. Check it in Settings › Dictation.");
      }
      const detail =
        text(obj(json.error).message) ||
        text(json.error) ||
        text(obj(json.detail).message) ||
        text(json.detail) ||
        text(json.err_msg);
      throw new Error(`The speech service said ${res.status}${detail ? `: ${this.scrub(detail).slice(0, 200)}` : ""}`);
    }
    return json;
  }

  /** A service's own error text can repeat what it was sent. The key never goes into a message. */
  private scrub(detail: string): string {
    const key = this.options.apiKey;
    return redactSecrets(key ? detail.split(key).join("[key]") : detail);
  }

  private bearer(): Record<string, string> {
    return this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {};
  }

  /** OpenAI's /audio/transcriptions: a multipart form with the file and the model. */
  private async openai(file: Buffer, options: TranscribeOptions, signal: AbortSignal): Promise<Transcript> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file)], { type: "audio/wav" }), "audio.wav");
    form.append("model", this.options.model);
    form.append("response_format", "json");
    if (options.language) form.append("language", options.language);
    if (options.prompt) form.append("prompt", options.prompt.slice(0, 800));
    const json = await this.send(this.options.url, { method: "POST", headers: this.bearer(), body: form }, signal);
    return { text: text(json.text).trim(), ...(text(json.language) ? { language: text(json.language) } : {}) };
  }

  /** Deepgram: the raw audio in the body, options in the address, "Token" for the key. */
  private async deepgram(file: Buffer, options: TranscribeOptions, signal: AbortSignal): Promise<Transcript> {
    const url = new URL(this.options.url);
    url.searchParams.set("model", this.options.model);
    url.searchParams.set("smart_format", "true");
    if (options.language) url.searchParams.set("language", options.language);
    else url.searchParams.set("detect_language", "true");
    const json = await this.send(
      url.toString(),
      {
        method: "POST",
        headers: {
          "content-type": "audio/wav",
          ...(this.options.apiKey ? { authorization: `Token ${this.options.apiKey}` } : {}),
        },
        body: new Uint8Array(file),
      },
      signal,
    );
    const channel = obj(
      Array.isArray(obj(json.results).channels) ? (obj(json.results).channels as unknown[])[0] : undefined,
    );
    const best = obj(Array.isArray(channel.alternatives) ? (channel.alternatives as unknown[])[0] : undefined);
    return {
      text: text(best.transcript).trim(),
      ...(text(channel.detected_language) ? { language: text(channel.detected_language) } : {}),
    };
  }

  /**
   * NVIDIA's speech NIM container: a multipart form with the file and a language such as "en-US". The key is optional
   * because a container on your own network usually has none.
   */
  private async nvidia(file: Buffer, options: TranscribeOptions, signal: AbortSignal): Promise<Transcript> {
    const form = new FormData();
    form.append("language", nvidiaLanguage(options.language));
    form.append("file", new Blob([new Uint8Array(file)], { type: "audio/wav" }), "audio.wav");
    const json = await this.send(this.options.url, { method: "POST", headers: this.bearer(), body: form }, signal);
    return { text: text(json.text).trim() };
  }

  /** ElevenLabs Scribe: a multipart form like OpenAI's, with `model_id` and the key in `xi-api-key`. */
  private async elevenlabs(file: Buffer, options: TranscribeOptions, signal: AbortSignal): Promise<Transcript> {
    const form = new FormData();
    form.append("model_id", this.options.model);
    form.append("file", new Blob([new Uint8Array(file)], { type: "audio/wav" }), "audio.wav");
    if (options.language) form.append("language_code", options.language);
    const json = await this.send(
      this.options.url,
      { method: "POST", headers: this.options.apiKey ? { "xi-api-key": this.options.apiKey } : {}, body: form },
      signal,
    );
    return {
      text: text(json.text).trim(),
      ...(text(json.language_code) ? { language: text(json.language_code) } : {}),
    };
  }
}
