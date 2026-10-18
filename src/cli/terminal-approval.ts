import { createInterface } from "node:readline/promises";
import type { ApprovalResponse, ApprovalUi } from "../gate/gate.js";
import type { Preview } from "../gate/preview.js";

/** Approval previews in a terminal: Send, Edit or Cancel. Ctrl-D or an empty answer on a destructive action cancels. */
export class TerminalApprovalUi implements ApprovalUi {
  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stderr,
  ) {}

  async request(preview: Preview, signal: AbortSignal): Promise<ApprovalResponse> {
    const rl = createInterface({ input: this.input, output: this.output, terminal: false });
    const ask = (q: string) => rl.question(q, { signal }).catch(() => "");
    try {
      const out = (s: string) => this.output.write(`${s}\n`);
      out("");
      out(`${preview.verb}: ${preview.summary}${preview.state === "edited" ? " (edited)" : ""}`);
      for (const field of preview.fields) out(`  ${field.label}: ${display(field.value)}`);
      for (const error of preview.errors ?? []) out(`  ! ${error}`);
      if (preview.stage === "confirm") {
        const answer = (await ask(`This can't be undone. Type "${preview.verb.toLowerCase()}" to confirm: `))
          .trim()
          .toLowerCase();
        return answer === preview.verb.toLowerCase() ? { decision: "approve" } : { decision: "cancel" };
      }
      const answer = (
        await ask(
          `[${preview.verb.toLowerCase().charAt(0) === "e" ? "Enter" : preview.verb}] s=${preview.verb}, e=Edit, c=Cancel: `,
        )
      )
        .trim()
        .toLowerCase();
      if (answer === "s" || answer === preview.verb.toLowerCase()) return { decision: "approve" };
      if (answer !== "e") return { decision: "cancel" };
      const input: Record<string, unknown> = { ...preview.raw };
      for (const field of preview.fields) {
        const next = await ask(`  ${field.label} [${display(field.value)}]: `);
        if (next.trim()) input[field.key] = Array.isArray(field.value) ? next.split(",").map((s) => s.trim()) : next;
      }
      return { decision: "edit", input };
    } finally {
      rl.close();
    }
  }
}

const display = (value: unknown) =>
  Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value : JSON.stringify(value);
