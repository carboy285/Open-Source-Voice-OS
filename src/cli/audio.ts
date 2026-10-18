import { readFile } from "node:fs/promises";
import type { Pcm16Audio } from "../core/types.js";

/** Reads an existing WAV in memory; the speech providers accept mono 16 kHz PCM16. */
export async function readAudio(path: string): Promise<Pcm16Audio> {
  return decodeWav(await readFile(path));
}

export function decodeWav(data: Buffer): Pcm16Audio {
  const invalid = () => new Error("--audio requires a valid mono 16 kHz PCM16 WAV file.");
  if (data.length < 12 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE")
    throw invalid();
  const end = data.readUInt32LE(4) + 8;
  if (end > data.length || end < 12) throw invalid();
  let format = false;
  let pcm: Uint8Array | undefined;
  for (let offset = 12; offset + 8 <= end;) {
    const name = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > end) throw invalid();
    if (name === "fmt ") {
      if (
        size < 16 ||
        data.readUInt16LE(start) !== 1 ||
        data.readUInt16LE(start + 2) !== 1 ||
        data.readUInt32LE(start + 4) !== 16000 ||
        data.readUInt32LE(start + 8) !== 32000 ||
        data.readUInt16LE(start + 12) !== 2 ||
        data.readUInt16LE(start + 14) !== 16
      )
        throw invalid();
      format = true;
    } else if (name === "data") {
      if (pcm || size === 0 || size % 2 !== 0) throw invalid();
      pcm = data.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!format || !pcm) throw invalid();
  return { pcm, sampleRate: 16000 };
}
