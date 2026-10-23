import { describe, expect, it } from "vitest";
import { parseAppConfig } from "../src/app/appConfig.js";
import { type Exec, MacInjector, resolveMacPath } from "../src/app/macos.js";
import { type Recorder, type UiState, VoiceSession } from "../src/app/session.js";
import { encodeWav, resample } from "../src/app/wav.js";
import { MemoryInjector } from "../src/providers/injectors.js";

describe("wav", () => {
  it("writes a valid 16-bit mono header and clamps samples", () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2]), 16000);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(40)).toBe(8);
    expect(wav.readInt16LE(46)).toBe(32767);
    expect(wav.readInt16LE(48)).toBe(-32768);
    expect(wav.readInt16LE(50)).toBe(32767);
  });

  it("resamples 48k to 16k by a factor of three", () => {
    expect(resample(new Float32Array(4800), 48000, 16000).length).toBe(1600);
  });
});

describe("MacInjector", () => {
  const recorder = () => {
    const calls: string[] = [];
    let clipboard = "original";
    const exec: Exec = async (command, args, input) => {
      if (command === "pbpaste") return clipboard;
      if (command === "pbcopy") {
        clipboard = input ?? "";
        calls.push(`copy:${clipboard}`);
        return "";
      }
      const script = args[1] ?? "";
      const action =
        script.includes('"v"') ? "paste"
        : script.includes('"c"') ? "copy"
        : script.includes('"a"') ? "select-all"
        : script.includes('"z"') ? "undo"
        : "other";
      calls.push(`osascript:${action}`);
      return "";
    };
    return { exec, calls, clipboard: () => clipboard, setClipboard: (v: string) => (clipboard = v) };
  };

  it("pastes via the clipboard and restores it afterwards", async () => {
    const r = recorder();
    await new MacInjector(r.exec, 0).insert("hello");
    expect(r.calls).toEqual(["copy:hello", "osascript:paste", "copy:original"]);
    expect(r.clipboard()).toBe("original");
  });

  it("returns an empty selection when nothing was copied", async () => {
    const r = recorder();
    expect(await new MacInjector(r.exec, 0).getSelection()).toBe("");
    expect(r.clipboard()).toBe("original");
  });

  it("reads the selection that Cmd+C puts on the clipboard", async () => {
    const r = recorder();
    const exec: Exec = async (command, args, input) => {
      if (command === "osascript") r.setClipboard("selected text"); // the target app copies its selection
      return r.exec(command, args, input);
    };
    expect(await new MacInjector(exec, 0).getSelection()).toBe("selected text");
    expect(r.clipboard()).toBe("original");
  });

  it("turns voice commands into the usual editing keystrokes", async () => {
    const r = recorder();
    const injector = new MacInjector(r.exec, 0);
    await injector.command?.("undo");
    await injector.command?.("selectAll");
    expect(r.calls).toEqual(["osascript:undo", "osascript:select-all"]);
  });
});

describe("resolveMacPath", () => {
  it("merges the login-shell PATH, the current one and Homebrew locations without duplicates", async () => {
    const path = await resolveMacPath("/usr/bin:/bin", "/Users/x", async () => "/opt/homebrew/bin:/usr/bin");
    expect(path.split(":")).toEqual(
      expect.arrayContaining(["/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/local/bin", "/Users/x/.npm-global/bin"]),
    );
    expect(path.split(":").length).toBe(new Set(path.split(":")).size);
  });

  it("falls back when the shell fails", async () => {
    const path = await resolveMacPath("/usr/bin", "/Users/x", async () => {
      throw new Error("no shell");
    });
    expect(path).toContain("/opt/homebrew/bin");
  });
});

describe("VoiceSession", () => {
  function setup(
    opts: { transcript?: string; heldMs?: number; snippets?: Record<string, string>; voiceCommands?: boolean } = {},
  ) {
    const events: Array<[UiState, string | undefined]> = [];
    const log: string[] = [];
    let clock = 0;
    let transcript = opts.transcript ?? "um hello world";
    const recorder: Recorder = {
      start: async () => void log.push("start"),
      stop: async () => (log.push("stop"), "/tmp/a.wav"),
      cancel: async () => void log.push("cancel"),
    };
    const injector = new MemoryInjector();
    const session = new VoiceSession({
      recorder,
      stt: { transcribe: async () => transcript },
      injector,
      llm: { complete: async () => ({ text: "x", toolCalls: [] }) },
      tools: async () => ({ list: async () => [], call: async () => "" }),
      confirm: async () => true,
      status: (state, text) => events.push([state, text]),
      now: () => clock,
      snippets: opts.snippets,
      voiceCommands: opts.voiceCommands,
    });
    return {
      session,
      injector,
      events,
      log,
      say: (text: string) => {
        transcript = text;
      },
      tap: async (mode: "dictate" | "edit" | "agent" = "dictate") => {
        session.press(mode);
        clock += opts.heldMs ?? 1000;
        await session.release();
      },
    };
  }

  it("dictates after a hold", async () => {
    const t = setup();
    await t.tap();
    expect(t.injector.text).toBe("Hello world.");
    expect(t.events.map(([s]) => s)).toEqual(["listening", "thinking", "done"]);
    expect(t.log).toEqual(["start", "stop"]);
  });

  it("ignores an accidental tap", async () => {
    const t = setup({ heldMs: 50 });
    await t.tap();
    expect(t.injector.text).toBe("");
    expect(t.log).toEqual(["start", "cancel"]);
  });

  it("reports an empty transcript", async () => {
    const t = setup({ transcript: "   " });
    await t.tap();
    expect(t.events.at(-1)).toEqual(["error", "I didn't catch that."]);
  });

  it("can be cancelled mid-recording and is reusable afterwards", async () => {
    const t = setup();
    t.session.press("dictate");
    await t.session.cancel();
    expect(t.session.busy).toBe(false);
    await t.tap();
    expect(t.injector.text).toBe("Hello world.");
  });

  it("returns to idle after an error", async () => {
    const t = setup();
    t.session["deps"].stt.transcribe = async () => {
      throw new Error("whisper missing");
    };
    await t.tap();
    expect(t.events.at(-1)).toEqual(["error", "whisper missing"]);
    expect(t.session.busy).toBe(false);
  });

  it("types a snippet verbatim instead of dictating it", async () => {
    const t = setup({
      transcript: "insert my address",
      snippets: { "my address": "1 Infinite Loop\nCupertino, CA" },
    });
    await t.tap();
    expect(t.injector.text).toBe("1 Infinite Loop\nCupertino, CA");
    expect(t.events.at(-1)).toEqual(["done", "Inserted “my address”."]);
  });

  it("scratches the previous insertion", async () => {
    const t = setup();
    await t.tap();
    expect(t.injector.text).toBe("Hello world.");
    t.say("scratch that");
    await t.tap();
    expect(t.injector.text).toBe("");
    expect(t.events.at(-1)).toEqual(["done", "Scratched that."]);
  });

  it("has nothing to scratch before any insertion", async () => {
    const t = setup({ transcript: "scratch that" });
    await t.tap();
    expect(t.injector.text).toBe("");
    expect(t.events.at(-1)).toEqual(["error", "Nothing to scratch."]);
  });

  it("selects everything on demand", async () => {
    const t = setup();
    await t.tap();
    t.say("select all");
    await t.tap();
    expect(t.injector.selection).toBe("Hello world.");
    expect(t.events.at(-1)).toEqual(["done", "Selected all."]);
  });

  it("dictates command-like phrases when voice commands are off", async () => {
    const t = setup({ transcript: "select all", voiceCommands: false });
    await t.tap();
    expect(t.injector.text).toBe("Select all.");
  });

  it("reports commands the injector cannot run", async () => {
    const t = setup({ transcript: "select all" });
    t.session["deps"].injector = {
      insert: async () => undefined,
      getSelection: async () => "",
      replaceSelection: async () => undefined,
    };
    await t.tap();
    expect(t.events.at(-1)).toEqual(["error", "Voice commands are not available here."]);
  });
});

describe("app config", () => {
  it("has no snippets and voice commands on by default", () => {
    const config = parseAppConfig(undefined);
    expect(config.snippets).toEqual({});
    expect(config.voiceCommands).toBe(true);
  });

  it("reads snippets from the settings file", () => {
    const config = parseAppConfig(JSON.stringify({ snippets: { "my address": "1 Infinite Loop" } }));
    expect(config.snippets["my address"]).toBe("1 Infinite Loop");
  });
});
