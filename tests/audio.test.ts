import { describe, expect, it } from "vitest";
import { isLikelyInvented, isSilent, speechStats } from "../src/dictation/audio.js";

const RATE = 16000;

function pcm(seconds: number, amplitude: number): Uint8Array {
  const buf = Buffer.alloc(Math.round(seconds * RATE) * 2);
  for (let i = 0; i < buf.length / 2; i++)
    buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 300 * i) / RATE)), i * 2);
  return new Uint8Array(buf);
}

describe("speech detection", () => {
  it("treats digital silence and faint hiss as silent", () => {
    expect(isSilent(speechStats({ pcm: pcm(2, 0), sampleRate: RATE }))).toBe(true);
    expect(isSilent(speechStats({ pcm: pcm(2, 40), sampleRate: RATE }))).toBe(true);
  });

  it("counts normal speech level as voiced", () => {
    const stats = speechStats({ pcm: pcm(1, 4000), sampleRate: RATE });
    expect(isSilent(stats)).toBe(false);
    expect(stats.voicedMs).toBeGreaterThan(900);
    expect(stats.durationMs).toBe(1000);
  });

  it("drops whisper's stock phrases only when there was little speech", () => {
    const short = speechStats({ pcm: pcm(0.5, 4000), sampleRate: RATE });
    const long = speechStats({ pcm: pcm(3, 4000), sampleRate: RATE });
    expect(isLikelyInvented("Thank you.", short)).toBe(true);
    expect(isLikelyInvented(" Thanks for watching!", short)).toBe(true);
    expect(isLikelyInvented("ご視聴ありがとうございました", short)).toBe(true);
    expect(isLikelyInvented("Thank you.", long)).toBe(false);
    expect(isLikelyInvented("Thank you for the notes", short)).toBe(false);
  });
});
