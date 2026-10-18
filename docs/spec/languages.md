# Languages

- Dictation supports 100+ spoken languages, detected automatically (B-D5). Murmur gets this from multilingual STT models (Whisper-family models cover ~99 languages; the count depends on the selected model) (D).
- Detection is per utterance. The user can pin one language or a short list of allowed languages; a pinned list limits detection to those (D).
- Output stays in the spoken language. Cleanup and polish never translate (D).
- Rule-based filler removal has per-language filler lists, starting with English and Japanese (e.g. Japanese hesitation sounds such as えーと, あの); other languages rely on model polish (D).
- Casing and sentence punctuation rules apply only to scripts that have them. For Japanese, the sentence-final mark is 。 and no spaces are added (D).
- UI language (English / Japanese) is separate from the dictation language (B-X4); see `platform.md`.
