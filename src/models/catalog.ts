/**
 * Speech models Murmur can download. NVIDIA Parakeet TDT 0.6B v3, converted to ggml by the
 * whisper.cpp project (huggingface.co/ggml-org/parakeet-GGUF). The original model is published by
 * NVIDIA under CC BY 4.0 (huggingface.co/nvidia/parakeet-tdt-0.6b-v3).
 */
export interface SpeechModel {
  id: string;
  engine: "parakeet";
  name: string;
  /** Short label for the size/quality trade-off. */
  variant: string;
  file: string;
  /** Rough download size, for the UI before the real size is known. */
  approxMB: number;
  /** BCP-47 codes the model transcribes. */
  languages: string[];
  recommended?: boolean;
  source: string;
  license: string;
}

export const MODEL_BASE_URL = "https://huggingface.co/ggml-org/parakeet-GGUF/resolve/main/";

/** Parakeet TDT v3: English plus 24 other European languages, detected automatically. */
const PARAKEET_V3_LANGUAGES = [
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "fi",
  "fr",
  "hr",
  "hu",
  "it",
  "lt",
  "lv",
  "mt",
  "nl",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "sv",
  "uk",
];

const parakeet = (variant: string, quant: string, approxMB: number, recommended = false): SpeechModel => ({
  id: `parakeet-tdt-0.6b-v3-${quant}`,
  engine: "parakeet",
  name: "NVIDIA Parakeet TDT 0.6B v3",
  variant,
  file: `ggml-parakeet-tdt-0.6b-v3-${quant}.bin`,
  approxMB,
  languages: PARAKEET_V3_LANGUAGES,
  recommended,
  source: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3",
  license: "CC BY 4.0",
});

export const MODELS: SpeechModel[] = [
  parakeet("balanced", "q8_0", 680, true),
  parakeet("full", "f16", 1250),
  parakeet("small", "q4_k", 420),
];

export const RECOMMENDED_MODEL = MODELS.find((m) => m.recommended)!;

export function findModel(id: string): SpeechModel | undefined {
  return MODELS.find((m) => m.id === id);
}
