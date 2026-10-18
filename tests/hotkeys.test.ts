import { describe, expect, it } from "vitest";
import { parseAppConfig, configToEnv } from "../src/app/appConfig.js";
import { HotkeyController } from "../src/app/hotkeys.js";

function setup() {
  const log: string[] = [];
  const controller = new HotkeyController(
    { dictate: "AltRight", edit: "MetaRight", agent: "CtrlRight" },
    { press: (m) => log.push(`press:${m}`), release: () => void log.push("release"), cancel: () => void log.push("cancel") },
  );
  const down = (key: string) => controller.handle({ type: "down", key });
  const up = (key: string) => controller.handle({ type: "up", key });
  return { log, down, up };
}

describe("HotkeyController", () => {
  it("presses on hold, ignores auto-repeat, releases on key up", () => {
    const { log, down, up } = setup();
    down("AltRight");
    down("AltRight");
    down("AltRight");
    up("AltRight");
    expect(log).toEqual(["press:dictate", "release"]);
  });

  it("maps each key to its mode", () => {
    const { log, down, up } = setup();
    down("MetaRight");
    up("MetaRight");
    down("CtrlRight");
    up("CtrlRight");
    expect(log).toEqual(["press:edit", "release", "press:agent", "release"]);
  });

  it("cancels when a normal key joins the hold, and does not release afterwards", () => {
    const { log, down, up } = setup();
    down("MetaRight");
    down("C");
    up("C");
    up("MetaRight");
    expect(log).toEqual(["press:edit", "cancel"]);
  });

  it("ignores other modifiers and unbound keys", () => {
    const { log, down, up } = setup();
    down("Shift");
    up("Shift");
    down("A");
    up("A");
    expect(log).toEqual([]);
    down("AltRight");
    down("ShiftRight");
    up("AltRight");
    expect(log).toEqual(["press:dictate", "release"]);
  });
});

describe("app config", () => {
  it("defaults to Codex with safe hotkeys", () => {
    const config = parseAppConfig(undefined);
    expect(config.llm).toBe("codex");
    expect(config.hotkeys).toEqual({ dictate: "AltRight", edit: "MetaRight", agent: "CtrlRight" });
    expect(config.polishDictation).toBe(false);
  });

  it("maps config to the environment used by the providers", () => {
    const env = configToEnv(parseAppConfig('{"whisperModel":"/m/ggml.bin","llm":"anthropic"}'));
    expect(env["VOICEOS_LLM"]).toBe("anthropic");
    expect(env["WHISPER_MODEL"]).toBe("/m/ggml.bin");
  });

  it("rejects an unknown backend", () => {
    expect(() => parseAppConfig('{"llm":"other"}')).toThrow();
  });
});
