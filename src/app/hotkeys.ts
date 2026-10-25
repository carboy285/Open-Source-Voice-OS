import type { VoiceMode } from "./session.js";

export interface KeyEvent {
  type: "down" | "up";
  /** uiohook key name, e.g. "AltRight". */
  key: string;
}

export interface HotkeyTarget {
  invalidateUndo?(): void;
  press(mode: VoiceMode): void;
  release(): void | Promise<void>;
  cancel(): void | Promise<void>;
}

const MODIFIERS = new Set(["Alt", "AltRight", "Ctrl", "CtrlRight", "Meta", "MetaRight", "Shift", "ShiftRight"]);

/**
 * Hold-to-talk bindings. Holding a bound key records; releasing it submits. If any other non-modifier key is
 * pressed while it is held, the hold was part of a normal key combination (Cmd+C, Option+e...), so it is cancelled.
 */
export class HotkeyController {
  private held: string | undefined;

  constructor(
    private readonly bindings: Record<VoiceMode, string>,
    private readonly target: HotkeyTarget,
  ) {}

  handle(event: KeyEvent): void {
    if (event.type === "down" && event.key === "Escape") {
      this.held = undefined;
      void this.target.cancel();
      return;
    }
    const mode = (Object.keys(this.bindings) as VoiceMode[]).find((m) => this.bindings[m] === event.key);
    if (event.type === "down") {
      if (this.held !== undefined) {
        if (event.key !== this.held && !MODIFIERS.has(event.key)) {
          this.held = undefined;
          void this.target.cancel();
        }
        return; // key auto-repeat or a chord in progress
      }
      if (!mode && !MODIFIERS.has(event.key)) this.target.invalidateUndo?.();
      if (mode) {
        this.held = event.key;
        this.target.press(mode);
      }
    } else if (event.key === this.held) {
      this.held = undefined;
      void this.target.release();
    }
  }
}
