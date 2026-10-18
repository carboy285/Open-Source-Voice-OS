import type { ApprovalResponse, ApprovalUi, FinalDecision } from "../../src/gate/gate.js";
import type { Preview } from "../../src/gate/preview.js";

type Step = ApprovalResponse | "hang" | ((preview: Preview) => ApprovalResponse | "hang");

/** Answers previews from a script. "hang" never answers (to test timeouts). */
export class ScriptedApprovalUi implements ApprovalUi {
  readonly shown: Preview[] = [];
  readonly dismissed: Array<{ callId: string; outcome: FinalDecision }> = [];
  constructor(private readonly script: Step[]) {}

  request(preview: Preview, signal: AbortSignal): Promise<ApprovalResponse> {
    this.shown.push(structuredClone(preview));
    const step = this.script.shift() ?? { decision: "cancel" };
    const answer = typeof step === "function" ? step(preview) : step;
    if (answer === "hang") {
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    return Promise.resolve(answer);
  }

  dismiss(callId: string, outcome: FinalDecision): void {
    this.dismissed.push({ callId, outcome });
  }
}

/** Fails the test if any preview is shown. */
export class NeverAskUi implements ApprovalUi {
  async request(preview: Preview): Promise<ApprovalResponse> {
    throw new Error(`Unexpected approval prompt for ${preview.tool}`);
  }
}
