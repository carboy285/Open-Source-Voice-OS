import type { SideEffects, ToolSpec, Verb } from "../core/types.js";

export type Risk = "normal" | "destructive";

export interface Classification {
  gated: boolean;
  risk: Risk;
  verb: Verb;
}

const GATING_FLAGS: Array<keyof SideEffects> = ["sends", "books", "modifies", "destructive"];

/**
 * Decides whether a tool needs approval (approval-gate.md).
 * - Built-in: gated when it declares sends/books/modifies/destructive, or when it does not declare readOnly.
 * - MCP: ungated only when annotations.readOnlyHint is exactly true.
 * - Unknown: gated.
 * Server hints can only add gating; they never ungate a built-in action.
 */
export function classify(spec: ToolSpec): Classification {
  const effects = spec.effects ?? {};
  const hints = spec.annotations;
  let gated: boolean;
  let destructive = effects.destructive === true || hints?.destructiveHint === true;

  if (spec.origin === "builtin") {
    gated = GATING_FLAGS.some((flag) => effects[flag] === true) || effects.readOnly !== true;
    if (hints && (hints.readOnlyHint === false || hints.destructiveHint === true)) gated = true;
  } else if (spec.origin === "mcp") {
    gated = hints?.readOnlyHint !== true;
    if (!gated) destructive = false;
  } else {
    gated = true;
  }

  return { gated, risk: gated && destructive ? "destructive" : "normal", verb: verbFor(spec, effects, destructive) };
}

function verbFor(spec: ToolSpec, effects: SideEffects, destructive: boolean): Verb {
  if (spec.preview?.verb) return spec.preview.verb;
  if (destructive) return "Delete";
  if (effects.sends) return "Send";
  if (effects.books) return "Book";
  if (effects.modifies) return "Save";
  return "Run";
}
