import type { Clock, Message } from "../core/types.js";
import { systemClock } from "../core/types.js";
import type { StepRecord } from "./agent.js";

export interface Turn {
  request: string;
  reply: string;
  /** What ran during the turn, kept short: enough to answer "the second one" or "undo that". */
  actions: Array<Pick<StepRecord, "tool" | "inputSummary" | "resultSummary" | "isError">>;
  at: number;
}

export const CONVERSATION_IDLE_MS = 30 * 60_000;
const MAX_TURNS = 10;
const MAX_CHARS = 12_000;
const MAX_ACTIONS = 6;

const flat = (s: string, max: number) => {
  const text = s.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * What the agent remembers between requests: the earlier requests, its replies and a short log of what it did.
 * Kept in memory only. It starts over after 30 quiet minutes or when the user starts a new chat.
 */
export class Conversation {
  private turns: Turn[] = [];

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly idleMs = CONVERSATION_IDLE_MS,
  ) {}

  private expire(): void {
    const last = this.turns.at(-1);
    if (last && this.clock.now() - last.at >= this.idleMs) this.turns = [];
  }

  get length(): number {
    this.expire();
    return this.turns.length;
  }

  reset(): void {
    this.turns = [];
  }

  add(turn: Omit<Turn, "at">): void {
    this.expire();
    this.turns.push({
      request: flat(turn.request, 1000),
      reply: flat(turn.reply, 1500),
      actions: turn.actions.slice(0, MAX_ACTIONS).map((a) => ({
        tool: a.tool,
        inputSummary: flat(a.inputSummary, 100),
        resultSummary: flat(a.resultSummary, 160),
        isError: a.isError,
      })),
      at: this.clock.now(),
    });
    this.trim();
  }

  private size(): number {
    return this.turns.reduce(
      (n, t) =>
        n +
        t.request.length +
        t.reply.length +
        t.actions.reduce((m, a) => m + a.inputSummary.length + a.resultSummary.length, 0),
      0,
    );
  }

  private trim(): void {
    while (this.turns.length > MAX_TURNS || (this.turns.length > 1 && this.size() > MAX_CHARS)) this.turns.shift();
  }

  /** The earlier turns as messages for the model, oldest first. Empty for a new or expired chat. */
  messages(): Message[] {
    this.expire();
    return this.turns.flatMap((turn): Message[] => {
      const log = turn.actions.length
        ? `\n\n<earlier_actions trust="untrusted">\n${turn.actions
            .map((a) =>
              `- ${a.tool}: ${a.inputSummary} → ${a.isError ? "failed: " : ""}${a.resultSummary}`.replaceAll(
                "</earlier_actions>",
                "",
              ),
            )
            .join("\n")}\n</earlier_actions>`
        : "";
      return [
        { role: "user", text: `Request: ${turn.request}` },
        { role: "assistant", text: `${turn.reply}${log}`, toolCalls: [] },
      ];
    });
  }
}
