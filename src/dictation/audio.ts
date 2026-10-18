import type { Pcm16Audio } from "../core/types.js";

/** Frames quieter than this RMS (about -48 dBFS) count as silence. */
const SILENCE_RMS = 0.004;
const FRAME_MS = 30;

export interface SpeechStats {
  durationMs: number;
  /** Time spent in frames louder than the silence threshold. */
  voicedMs: number;
  /** Loudest frame RMS, 0..1. */
  peakRms: number;
}

/** Cheap energy-based speech estimate, used to skip whisper on silent recordings. */
export function speechStats(audio: Pcm16Audio): SpeechStats {
  const view = new DataView(audio.pcm.buffer, audio.pcm.byteOffset, audio.pcm.byteLength);
  const samples = Math.floor(audio.pcm.byteLength / 2);
  const frame = Math.max(1, Math.round((audio.sampleRate * FRAME_MS) / 1000));
  let voicedFrames = 0;
  let peakRms = 0;
  for (let start = 0; start < samples; start += frame) {
    const end = Math.min(samples, start + frame);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const value = view.getInt16(i * 2, true) / 32768;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / (end - start));
    if (rms > peakRms) peakRms = rms;
    if (rms >= SILENCE_RMS) voicedFrames++;
  }
  return {
    durationMs: (samples / audio.sampleRate) * 1000,
    voicedMs: voicedFrames * FRAME_MS,
    peakRms,
  };
}

/** Under this much voiced audio there is nothing worth sending to whisper. */
export const MIN_VOICED_MS = 150;

export function isSilent(stats: SpeechStats): boolean {
  return stats.voicedMs < MIN_VOICED_MS;
}

/**
 * Phrases whisper tends to invent from silence or breath noise (it learned them from subtitles).
 * They are dropped only when the recording had little speech in it, so a real "thank you" survives.
 */
const INVENTED = [
  "thank you",
  "thank you very much",
  "thanks",
  "thanks for watching",
  "thank you for watching",
  "thank you so much for watching",
  "please subscribe",
  "subscribe to my channel",
  "you",
  "bye",
  "bye bye",
  "okay",
  "so",
  "the end",
  "ご視聴ありがとうございました",
  "ありがとうございました",
  "おやすみなさい",
];

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[\s.,!?。、！？…"'()[\]-]+/g, " ")
    .trim();

const INVENTED_SET = new Set(INVENTED.map(normalize));

/** True when the transcript is one of whisper's stock phrases and the audio had under 1.2 s of speech. */
export function isLikelyInvented(text: string, stats: SpeechStats): boolean {
  return stats.voicedMs < 1200 && INVENTED_SET.has(normalize(text));
}
