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

/** One line of the chat the user can read: what they asked, what came back, and what ran. */
export interface ChatEntry {
  id: number;
  request: string;
  reply: string;
  /** "done", "failed" or "cancelled". Failed and cancelled turns show up here but are not remembered by the model. */
  status: "done" | "failed" | "cancelled";
  actions: Array<{ tool: string; summary: string; isError: boolean }>;
  at: number;
}

export interface ChatSnapshot {
  entries: ChatEntry[];
  /** The request being worked on right now, if any. */
  pending?: { request: string };
}

export const CONVERSATION_IDLE_MS = 30 * 60_000;
const MAX_SHOWN = 40;
const SHOWN_CHARS = 6000;
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
  private shown: ChatEntry[] = [];
  private pending?: { request: string };
  private nextId = 1;
  /** Called whenever the chat the user sees changes. */
  onChange?: () => void;

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly idleMs = CONVERSATION_IDLE_MS,
  ) {}

  private expire(): void {
    const last = this.turns.at(-1);
    if (last && this.clock.now() - last.at >= this.idleMs) this.turns = [];
    // The chat on screen starts over with the model's memory, so it never shows more than the AI remembers.
    const lastShown = this.shown.at(-1);
    if (lastShown && !this.pending && this.clock.now() - lastShown.at >= this.idleMs) this.shown = [];
  }

  get length(): number {
    this.expire();
    return this.turns.length;
  }

  reset(): void {
    this.turns = [];
    this.shown = [];
    this.pending = undefined;
    this.onChange?.();
  }

  /** A request has started. The chat shows it right away, with "thinking" under it. */
  begin(request: string): void {
    this.expire();
    this.pending = { request: request.slice(0, SHOWN_CHARS) };
    this.onChange?.();
  }

  /** The chat the user can read, oldest first. A copy, so the screen can't change what the AI remembers. */
  snapshot(): ChatSnapshot {
    this.expire();
    return { entries: structuredClone(this.shown), ...(this.pending ? { pending: { ...this.pending } } : {}) };
  }

  /** A request ended, however it ended. It goes on the chat the user sees. */
  record(entry: Omit<ChatEntry, "id" | "at">): void {
    this.expire();
    this.pending = undefined;
    this.shown.push({
      ...entry,
      id: this.nextId++,
      request: entry.request.slice(0, SHOWN_CHARS),
      reply: entry.reply.slice(0, SHOWN_CHARS),
      actions: entry.actions.slice(0, 8).map((a) => ({ ...a, summary: flat(a.summary, 140) })),
      at: this.clock.now(),
    });
    if (this.shown.length > MAX_SHOWN) this.shown.splice(0, this.shown.length - MAX_SHOWN);
    this.onChange?.();
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
