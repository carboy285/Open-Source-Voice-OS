import type { ToolSpec } from "../core/types.js";
import { classify } from "./classify.js";

/** How much of the user's own say Murmur may skip. "ask" is the default and shows a preview for every gated action. */
export type ApprovalMode = "ask" | "auto" | "full";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["ask", "auto", "full"];

/** Anything but an exact, known mode is "ask": a damaged or hand-edited setting can only make Murmur more careful. */
export const parseApprovalMode = (value: unknown): ApprovalMode =>
  value === "auto" || value === "full" ? value : "ask";

/** Tools that start other programs working for the user. They keep asking in "auto". */
const ALWAYS_ASK = new Set(["agents.start", "agents.send"]);

/** Buttons and menu items that send, delete, spend or leave something behind. */
const RISKY_LABEL =
  /\b(send|reply|forward|delete|remove|erase|trash|empty|discard|clear|reset|format|uninstall|pay|buy|purchase|order|checkout|subscribe|submit|confirm|post|publish|share|invite|transfer|withdraw|sign out|log out|logout|install|allow|grant|authorize|quit all|force quit|shut ?down|restart)\b/i;

/** Keys that send, delete or quit. */
const RISKY_KEYS = /(^|\+)(return|enter|delete|backspace|forwarddelete)$|^cmd\+(q|w)$|^command\+(q|w)$/i;

const PEOPLE_KEYS = /^(to|cc|bcc|recipients?|attendees|guests|invitees|emails?|attendee_emails)$/i;

const filled = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.trim() !== "" : Boolean(value);

/**
 * In "Approve for me" mode, whether this one call still needs the user. Yes for anything that reaches other
 * people, deletes, or can't be judged (an unknown tool from an MCP server), and for clicks, keys and menu items whose
 * own words say send, delete, pay and the like. No for routine things on the user's own computer.
 */
export function potentiallyUnsafe(spec: ToolSpec, input: Record<string, unknown>): boolean {
  const effects = spec.effects ?? {};
  if (classify(spec).risk === "destructive" || effects.destructive === true) return true;
  if (effects.sends === true) return true;
  if (spec.origin === "mcp") return true;
  if (ALWAYS_ASK.has(spec.name)) return true;
  if (Object.entries(input).some(([key, value]) => PEOPLE_KEYS.test(key) && filled(value))) return true;

  if (spec.name === "computer.click" || spec.name === "computer.choose_menu") {
    let words = "";
    try {
      words = spec.preview?.summarize(input) ?? "";
    } catch {
      return true;
    }
    // A summary Murmur could not write from what it saw on the screen is not one it can judge.
    return !words || /wasn't on the last look/.test(words) || RISKY_LABEL.test(words);
  }
  if (spec.name === "computer.press_keys") return RISKY_KEYS.test(String(input.keys ?? "").trim());
  if (spec.name === "computer.type") return /[\r\n]/.test(String(input.text ?? ""));
  return false;
}
