import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WhisperServerStt } from "../src/providers/whisper-server.js";

let server: WhisperServerStt | undefined;
let directory: string | undefined;
afterEach(async () => {
  server?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it("keeps the same local speech server between requests and restarts after shutdown", async () => {
  directory = await mkdtemp(join(tmpdir(), "voiceos-whisper-test-"));
  const audio = { pcm: new Uint8Array(3200), sampleRate: 16000 };
  server = new WhisperServerStt("fake-model", resolve("tests/fixtures/fake-whisper-server.mjs"));
  expect(await server.transcribe(audio)).toEqual({ text: "transcript 1" });
  expect(await server.transcribe(audio)).toEqual({ text: "transcript 2" });
  server.close();
  expect(await server.transcribe(audio)).toEqual({ text: "transcript 1" });
});
it("does not start a server for a cancelled request", async () => {
  server = new WhisperServerStt("fake-model", "missing-binary");
  const controller = new AbortController();
  controller.abort();
  await expect(
    server.transcribe({ pcm: new Uint8Array(3200), sampleRate: 16000 }, { signal: controller.signal }),
  ).rejects.toThrow();
});
it("reports a missing persistent speech binary", async () => {
  server = new WhisperServerStt("fake-model", "/nonexistent/voiceos-whisper-server");
  await expect(server.transcribe({ pcm: new Uint8Array(3200), sampleRate: 16000 })).rejects.toThrow("Could not start");
});
