import type { Clock, ToolCall, ToolSpec } from "../core/types.js";
import { systemClock } from "../core/types.js";
import { classify } from "./classify.js";
import { buildPreview, coerceInput, type Preview } from "./preview.js";
import { parseApprovalMode, potentiallyUnsafe, type ApprovalMode } from "./safety.js";
import { validate } from "./schema.js";

export interface ApprovalResponse {
  decision: "approve" | "edit" | "cancel";
  /** Edited input. With "approve", an input that differs from the shown one is treated as an edit. */
  input?: Record<string, unknown>;
}

/** The surface that shows previews: a native window over RPC, a terminal prompt, or a test fake. */
export interface ApprovalUi {
  /** Shows or refreshes a preview and resolves with the user's next response. Closing the window must resolve "cancel". */
  request(preview: Preview, signal: AbortSignal): Promise<ApprovalResponse>;
  /** The preview is finished; the UI should close it. */
  dismiss?(callId: string, outcome: FinalDecision): void;
}

export type FinalDecision = "approved" | "edited" | "cancelled" | "expired";

export interface GateOutcome {
  /** "auto" means the tool is read-only and ran without a prompt. */
  decision: "auto" | FinalDecision;
  /** The exact input to run with: the last one the user saw. */
  input: Record<string, unknown>;
}

export interface GateOptions {
  /** No response within this time is treated as Cancel. Default 10 minutes. */
  timeoutMs?: number;
  clock?: Clock;
  /** IANA zone and locale of the user, for the times on a preview card. */
  timeZone?: string;
  locale?: string;
  /**
   * How much the user wants to be asked: "ask" (every gated call), "auto" (only risky ones) or "full" (none).
   * Read on every call, so a change in Settings applies to the next action. Unknown values mean "ask".
   */
  mode?: () => ApprovalMode;
  /** Called on every state change, e.g. to mark a task as waiting_approval. */
  onState?: (callId: string, state: Preview["state"] | FinalDecision) => void;
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

const sameInput = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/**
 * Invariant: a gated tool runs only after the user approved that exact call and input, unless the user themselves
 * chose "Approve for me" (risky calls still ask) or "Full access" in Settings. The mode is the user's setting alone:
 * the model, a connector or a tool result cannot change it, and anything unrecognised means "ask".
 */
export class ApprovalGate {
  private readonly timeoutMs: number;
  private readonly clock: Clock;

  constructor(
    private readonly ui: ApprovalUi,
    private readonly options: GateOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.clock = options.clock ?? systemClock;
  }

  async review(call: ToolCall, spec: ToolSpec, signal?: AbortSignal): Promise<GateOutcome> {
    if (!classify(spec).gated) return { decision: "auto", input: call.input };
    // The user's own choice of how much to be asked (Settings › Approvals). Without it, everything is shown first.
    const mode = parseApprovalMode(this.options.mode?.());
    if (mode === "full" || (mode === "auto" && !potentiallyUnsafe(spec, call.input))) {
      return { decision: "auto", input: call.input };
    }

    let shown = structuredClone(call.input);
    let state: Preview["state"] = "pending";
    let stage: Preview["stage"] = "review";
    let errors: string[] | undefined;
    const risk = classify(spec).risk;

    for (;;) {
      if (signal?.aborted) return this.finish(call.id, "cancelled", shown);
      this.options.onState?.(call.id, state);
      const preview = buildPreview(call, spec, shown, {
        state,
        stage,
        errors,
        expiresAt: this.clock.now() + this.timeoutMs,
        card: {
          now: this.clock.now(),
          timeZone: this.options.timeZone ?? "UTC",
          locale: this.options.locale ?? "en-US",
        },
      });
      const response = await this.ask(preview, signal);
      if (response === "expired") return this.finish(call.id, "expired", shown);
      errors = undefined;

      if (response.decision === "cancel") return this.finish(call.id, "cancelled", shown);

      const proposed = response.input ? coerceInput(spec.inputSchema, response.input) : undefined;
      if (response.decision === "edit" || (proposed && !sameInput(proposed, shown))) {
        const next = proposed ?? shown;
        const problems = validate(spec.inputSchema, next);
        if (problems.length) {
          errors = problems;
        } else if (!sameInput(next, shown)) {
          shown = next;
          state = "edited";
        }
        stage = "review";
        continue;
      }

      if (risk === "destructive" && stage === "review") {
        stage = "confirm";
        continue;
      }
      return this.finish(call.id, state === "edited" ? "edited" : "approved", shown);
    }
  }

  private finish(callId: string, decision: FinalDecision, input: Record<string, unknown>): GateOutcome {
    this.options.onState?.(callId, decision);
    this.ui.dismiss?.(callId, decision);
    return { decision, input };
  }

  private ask(preview: Preview, outer?: AbortSignal): Promise<ApprovalResponse | "expired"> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    outer?.addEventListener("abort", onAbort, { once: true });
    return new Promise<ApprovalResponse | "expired">((resolve) => {
      const timer = setTimeout(() => {
        controller.abort();
        resolve("expired");
      }, this.timeoutMs);
      const done = (value: ApprovalResponse | "expired") => {
        clearTimeout(timer);
        outer?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      controller.signal.addEventListener("abort", () => done(outer?.aborted ? { decision: "cancel" } : "expired"), {
        once: true,
      });
      this.ui.request(preview, controller.signal).then(done, () => done({ decision: "cancel" }));
    });
  }
}
