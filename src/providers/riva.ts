/**
 * The few protobuf messages of NVIDIA Riva's speech-recognition service that Murmur needs, written out by hand so no
 * protobuf library is required. Field numbers come from NVIDIA's riva_asr.proto (RecognizeRequest, RecognitionConfig,
 * RecognizeResponse, SpeechRecognitionResult, SpeechRecognitionAlternative).
 */

export const RIVA_RECOGNIZE = "/nvidia.riva.asr.RivaSpeechRecognition/Recognize";

const varint = (value: number): Buffer => {
  const bytes: number[] = [];
  let n = value;
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return Buffer.from(bytes);
};
const tag = (field: number, wire: 0 | 2): Buffer => varint((field << 3) | wire);
const numberField = (field: number, value: number): Buffer => Buffer.concat([tag(field, 0), varint(value)]);
const bytesField = (field: number, value: Buffer): Buffer =>
  Buffer.concat([tag(field, 2), varint(value.length), value]);

/** LINEAR_PCM in Riva's AudioEncoding. */
const LINEAR_PCM = 1;

/** A RecognizeRequest for raw 16-bit mono audio. */
export function encodeRecognize(pcm: Uint8Array, sampleRate: number, language: string): Buffer {
  const config = Buffer.concat([
    numberField(1, LINEAR_PCM), // encoding
    numberField(2, sampleRate), // sample_rate_hertz
    bytesField(3, Buffer.from(language)), // language_code
    numberField(4, 1), // max_alternatives
    numberField(11, 1), // enable_automatic_punctuation
  ]);
  return Buffer.concat([bytesField(1, config), bytesField(2, Buffer.from(pcm))]);
}

interface Field {
  field: number;
  wire: number;
  data: Buffer;
}

/** The fields of one protobuf message. Length-delimited fields keep their bytes; the rest are skipped. */
function fields(buffer: Buffer): Field[] {
  const out: Field[] = [];
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = buffer[at++];
      if (byte === undefined) throw new Error("The speech reply was cut short.");
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
      shift += 7;
    }
  };
  while (at < buffer.length) {
    const key = readVarint();
    const wire = key & 7;
    const field = Math.floor(key / 8);
    if (wire === 0) readVarint();
    else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else if (wire === 2) {
      const length = readVarint();
      out.push({ field, wire, data: buffer.subarray(at, at + length) });
      at += length;
    } else throw new Error("The speech reply was in a format Murmur doesn't understand.");
  }
  return out;
}

/** The text of a RecognizeResponse: the best alternative of each result, joined. */
export function decodeRecognize(buffer: Buffer): string {
  const parts: string[] = [];
  for (const result of fields(buffer).filter((f) => f.field === 1)) {
    const best = fields(result.data).find((f) => f.field === 1);
    const transcript = best && fields(best.data).find((f) => f.field === 1);
    if (transcript) parts.push(transcript.data.toString("utf8").trim());
  }
  return parts.filter(Boolean).join(" ");
}
