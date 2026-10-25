import { afterEach, expect, it } from "vitest";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WhisperServerStt } from "../src/providers/whisper.js";

let server: WhisperServerStt | undefined;
let directory: string | undefined;
afterEach(async () => { server?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
it("keeps the same local speech server between requests and restarts after shutdown", async () => {
  directory = await mkdtemp(join(tmpdir(), "voiceos-whisper-test-"));
  const audio = join(directory, "audio.wav"); await writeFile(audio, "test audio");
  server = new WhisperServerStt("fake-model", resolve("tests/fixtures/fake-whisper-server.mjs"));
  expect(await server.transcribe(audio)).toBe("transcript 1");
  expect(await server.transcribe(audio)).toBe("transcript 2");
  server.close();
  expect(await server.transcribe(audio)).toBe("transcript 1");
});
it("relaunches a server that died after starting", async () => {
  directory = await mkdtemp(join(tmpdir(), "voiceos-whisper-test-"));
  const audio = join(directory, "audio.wav"); await writeFile(audio, "test audio");
  server = new WhisperServerStt("fake-model", resolve("tests/fixtures/fake-whisper-server.mjs"));
  expect(await server.transcribe(audio)).toBe("transcript 1");
  const child = server["child"]!;
  child.kill("SIGKILL"); await once(child, "exit");
  expect(await server.transcribe(audio)).toBe("transcript 1");
});
it("does not start a server for a cancelled request", async () => {
  server = new WhisperServerStt("fake-model", "missing-binary");
  const controller = new AbortController(); controller.abort();
  await expect(server.transcribe("unused.wav", controller.signal)).rejects.toThrow();
});
it("reports a missing persistent speech binary", async () => {
  server = new WhisperServerStt("fake-model", "/nonexistent/voiceos-whisper-server");
  await expect(server.transcribe("unused.wav")).rejects.toThrow("Could not start");
});
