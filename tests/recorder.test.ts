import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

function setup() {
  const log: string[] = [];
  const handlers: Record<string, () => Promise<void>> = {};
  const audio: Array<{ samples: Float32Array; rate: number }> = [];
  const errors: string[] = [];
  let openMicrophone!: () => void;
  let failWorklet = false;
  let emit: ((samples: Float32Array) => void) | undefined;
  const microphone = new Promise<void>((resolve) => (openMicrophone = resolve));
  runInNewContext(readFileSync("src/app/assets/recorder.js", "utf8"), {
    Float32Array,
    Blob,
    URL: { createObjectURL: () => "blob:worklet", revokeObjectURL: () => log.push("revoke") },
    navigator: { mediaDevices: { getUserMedia: async () => {
      log.push("opening");
      await microphone;
      return { getTracks: () => [{ stop: () => log.push("track stopped") }] };
    } } },
    AudioContext: class {
      sampleRate = 16000;
      destination = {};
      audioWorklet = { addModule: async () => {
        if (failWorklet) throw new Error("worklet failed");
      } };
      createMediaStreamSource() { return { connect: () => log.push("source connected"), disconnect: () => {} }; }
      async close() { log.push("context closed"); }
    },
    AudioWorkletNode: class {
      port: { onmessage?: (event: { data: Float32Array }) => void } = {};
      constructor() { emit = (samples) => this.port.onmessage?.({ data: samples }); }
      connect() { log.push("worklet connected"); }
      disconnect() {}
    },
    window: { voiceos: {
      onRecorderStart: (callback: () => Promise<void>) => (handlers.start = callback),
      onRecorderStop: (callback: () => Promise<void>) => (handlers.stop = callback),
      onRecorderCancel: (callback: () => Promise<void>) => (handlers.cancel = callback),
      sendAudio: (samples: Float32Array, rate: number) => audio.push({ samples, rate }),
      sendRecorderError: (error: string) => errors.push(error),
    } },
  });
  return {
    log, audio, errors, openMicrophone,
    start: () => handlers.start!(), stop: () => handlers.stop!(), cancel: () => handlers.cancel!(),
    emit: (samples: number[]) => emit?.(Float32Array.from(samples)),
    failWorklet: (fail: boolean) => (failWorklet = fail),
  };
}

describe("desktop recorder lifecycle", () => {
  it("waits for microphone startup before stopping and releasing resources", async () => {
    const r = setup();
    const starting = r.start();
    const stopping = r.stop();
    await Promise.resolve();
    expect(r.log).toEqual(["opening"]);
    expect(r.audio).toEqual([]);
    r.openMicrophone();
    await starting;
    await stopping;
    expect(r.log).toEqual(["opening", "revoke", "source connected", "worklet connected", "track stopped", "context closed"]);
    expect(r.audio[0]?.rate).toBe(16000);
  });

  it("finishes cancellation before starting the next microphone", async () => {
    const r = setup();
    const first = r.start();
    const cancelling = r.cancel();
    const next = r.start();
    r.openMicrophone();
    await Promise.all([first, cancelling, next]);
    expect(r.log.indexOf("track stopped")).toBeLessThan(r.log.lastIndexOf("opening"));
    r.emit([0.5, -0.5]);
    await r.stop();
    expect(Array.from(r.audio[0]!.samples)).toEqual([0.5, -0.5]);
    expect(r.errors).toEqual([]);
  });

  it("releases a partially opened microphone after failure and can record again", async () => {
    const r = setup();
    r.failWorklet(true);
    r.openMicrophone();
    await r.start();
    expect(r.errors).toEqual(["worklet failed"]);
    expect(r.log).toContain("track stopped");
    expect(r.log).toContain("context closed");
    r.failWorklet(false);
    await r.start();
    r.emit([1]);
    await r.stop();
    expect(Array.from(r.audio[0]!.samples)).toEqual([1]);
  });
});
