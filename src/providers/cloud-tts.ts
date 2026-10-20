import { describeError, redactSecrets } from "../core/redact.js";
import type { TtsApi } from "./catalog.js";

export interface CloudTtsOptions {
  api: TtsApi;
  /** Full address of the speech endpoint. */
  url: string;
  model: string;
  voice: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface Speech {
  audio: Buffer;
  mediaType: string;
}

/** Longest text sent for one spoken reply. Longer replies are cut at a sentence so a long answer doesn't run up a bill. */
export const MAX_SPOKEN_CHARS = 2500;
const MAX_AUDIO_BYTES = 20_000_000;

export function trimForSpeech(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_SPOKEN_CHARS) return clean;
  const cut = clean.slice(0, MAX_SPOKEN_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > MAX_SPOKEN_CHARS / 2 ? cut.slice(0, end + 1) : cut;
}

/**
 * Text to speech through a hosted service, with the user's own key. The text of the reply is sent to that service and
 * comes back as an MP3 for the shell to play. OpenAI and servers that copy its address share one format; ElevenLabs
 * and Deepgram have their own.
 */
export class CloudTts {
  constructor(private readonly options: CloudTtsOptions) {}

  async synthesize(input: string, signal?: AbortSignal): Promise<Speech> {
    const text = trimForSpeech(input);
    if (!text) throw new Error("There is nothing to say.");
    if (!this.options.url) throw new Error("Add the address of your speech server in Settings › Agent.");
    const { url, init } = this.request(text);
    const guard = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.options.timeoutMs ?? 30_000)]);
    let res: Response;
    try {
      res = await (this.options.fetch ?? fetch)(url, { ...init, signal: guard });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(
        guard.aborted
          ? "The voice service took too long to answer."
          : `Couldn't reach the voice service: ${describeError(error)}`,
      );
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error("The voice service didn't accept the key. Check it in Settings › Agent.");
      }
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      const safe = redactSecrets(this.options.apiKey ? detail.split(this.options.apiKey).join("[key]") : detail);
      throw new Error(`The voice service said ${res.status}${safe ? `: ${safe}` : ""}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new Error("The voice service sent no audio.");
    if (audio.length > MAX_AUDIO_BYTES) throw new Error("The voice service sent too much audio.");
    return { audio, mediaType: res.headers.get("content-type")?.split(";")[0]?.trim() || "audio/mpeg" };
  }

  private request(text: string): { url: string; init: RequestInit } {
    const { api, url, model, voice, apiKey } = this.options;
    const json = { "content-type": "application/json" };
    if (api === "elevenlabs") {
      const base = `${url.replace(/\/+$/, "")}/${encodeURIComponent(voice)}`;
      return {
        url: `${base}?output_format=mp3_44100_128`,
        init: {
          method: "POST",
          headers: { ...json, accept: "audio/mpeg", ...(apiKey ? { "xi-api-key": apiKey } : {}) },
          body: JSON.stringify({ text, model_id: model }),
        },
      };
    }
    if (api === "deepgram") {
      const address = new URL(url);
      address.searchParams.set("model", model);
      address.searchParams.set("encoding", "mp3");
      return {
        url: address.toString(),
        init: {
          method: "POST",
          headers: { ...json, ...(apiKey ? { authorization: `Token ${apiKey}` } : {}) },
          body: JSON.stringify({ text }),
        },
      };
    }
    return {
      url,
      init: {
        method: "POST",
        headers: { ...json, ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, voice, input: text, response_format: "mp3" }),
      },
    };
  }
}
