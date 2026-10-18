import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Clock } from "../core/types.js";
import { systemClock } from "../core/types.js";
import type { ApprovalUi } from "../gate/gate.js";
import type { Card } from "../gate/card.js";
import type { Preview } from "../gate/preview.js";
import type {
  AdapterHandle,
  AdapterSink,
  AgentAdapter,
  AgentAnswer,
  AgentAsk,
  AgentKind,
  AgentSession,
  Detection,
} from "./types.js";

export type HubEvent =
  | { type: "agents.update"; session: AgentSession }
  | { type: "notify"; title: string; body: string; kind: "status" | "completion" | "warning" | "error" };

export interface HubOptions {
  adapters: AgentAdapter[];
  approvals: ApprovalUi;
  emit(event: HubEvent): void;
  /** Which agents the user switched on. */
  isEnabled(kind: AgentKind): boolean;
  clock?: Clock;
  /** How long a question waits before it counts as "no". */
  timeoutMs?: () => number;
  /** Folders the user used before, offered back to the agent. */
  recentFolders?: { get(): string[]; set(folders: string[]): void };
  maxActive?: number;
}

const ACTIVE = new Set(["starting", "working", "needs_you", "idle"]);
const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/**
 * Starts and watches coding agents (Codex, Claude Code, OpenCode) on this computer. When one stops to ask, the
 * question becomes a card in the notch. Nothing is ever approved by default: no answer, a timeout, or closing the
 * card is a "no".
 */
export class AgentHub {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly handles = new Map<string, AdapterHandle>();
  private readonly clock: Clock;
  private asks = 0;

  constructor(private readonly options: HubOptions) {
    this.clock = options.clock ?? systemClock;
  }

  adapter(kind: string): AgentAdapter {
    const found = this.options.adapters.find((a) => a.kind === kind);
    if (!found)
      throw new Error(
        `I don't know an agent called "${kind}". Try ${this.options.adapters.map((a) => a.kind).join(", ")}.`,
      );
    return found;
  }

  async detect(): Promise<Array<{ kind: AgentKind; label: string; enabled: boolean } & Detection>> {
    return Promise.all(
      this.options.adapters.map(async (a) => ({
        kind: a.kind,
        label: a.label,
        enabled: this.options.isEnabled(a.kind),
        ...(await a.detect().catch((): Detection => ({ installed: false }))),
      })),
    );
  }

  list(): AgentSession[] {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  recent(): string[] {
    return this.options.recentFolders?.get() ?? [];
  }

  private publish(session: AgentSession): void {
    this.options.emit({ type: "agents.update", session: { ...session } });
  }

  private update(session: AgentSession, patch: Partial<AgentSession>): void {
    Object.assign(session, patch);
    this.publish(session);
  }

  /** Checks a folder the model or the user named. It has to be a real directory, written out in full. */
  static folder(raw: string): string {
    const text = raw.trim().replace(/^~(?=$|\/)/, homedir());
    if (!text || !isAbsolute(text)) throw new Error("Give the folder as a full path, like /Users/you/project.");
    const path = resolve(text);
    if (path === "/" || path === resolve(homedir(), ".."))
      throw new Error("That folder is too broad. Pick the project's own folder.");
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      /* missing */
    }
    if (!isDir) throw new Error(`There is no folder at ${path}.`);
    return path;
  }

  async start(input: { kind: string; folder: string; task: string }): Promise<AgentSession> {
    const adapter = this.adapter(input.kind);
    if (!this.options.isEnabled(adapter.kind)) throw new Error(`${adapter.label} is switched off in Settings.`);
    const task = input.task.trim();
    if (!task) throw new Error("Say what the agent should do.");
    if (task.length > 4000) throw new Error("That task is too long. Keep it under 4,000 characters.");
    const cwd = AgentHub.folder(input.folder);
    const active = this.list().filter((s) => ACTIVE.has(s.status)).length;
    if (active >= (this.options.maxActive ?? 4)) throw new Error("Four agents are already running. Stop one first.");

    const session: AgentSession = {
      id: randomUUID().slice(0, 8),
      kind: adapter.kind,
      label: adapter.label,
      cwd,
      task,
      status: "starting",
      text: "Starting…",
      startedAt: this.clock.now(),
    };
    this.sessions.set(session.id, session);
    this.publish(session);
    const folders = [cwd, ...this.recent().filter((f) => f !== cwd)].slice(0, 5);
    this.options.recentFolders?.set(folders);

    try {
      const handle = await adapter.start({ cwd, prompt: task }, this.sink(session));
      if (session.status === "failed" || session.status === "stopped") await handle.stop().catch(() => {});
      else this.handles.set(session.id, handle);
    } catch (error) {
      this.fail(session, error instanceof Error ? error.message : String(error));
    }
    return session;
  }

  async send(id: string, text: string): Promise<void> {
    const session = this.require(id);
    const handle = this.handles.get(id);
    if (!handle || !ACTIVE.has(session.status)) throw new Error(`${session.label} is not running.`);
    await handle.send(text);
    this.update(session, { status: "working", text: "Working on your follow-up…" });
  }

  async stop(id: string): Promise<void> {
    const session = this.require(id);
    const handle = this.handles.get(id);
    this.handles.delete(id);
    this.update(session, { status: "stopped", text: "Stopped.", finishedAt: this.clock.now() });
    await handle?.stop().catch(() => {});
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].filter((id) => this.handles.has(id)).map((id) => this.stop(id)));
  }

  private require(id: string): AgentSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`There is no agent session ${id}.`);
    return session;
  }

  private fail(session: AgentSession, message: string): void {
    if (session.status === "stopped") return;
    this.handles
      .get(session.id)
      ?.stop()
      .catch(() => {});
    this.handles.delete(session.id);
    this.update(session, { status: "failed", text: clip(message, 200), error: message, finishedAt: this.clock.now() });
    this.options.emit({ type: "notify", title: `${session.label} stopped`, body: clip(message, 200), kind: "error" });
  }

  private sink(session: AgentSession): AdapterSink {
    return {
      working: (text) => {
        if (session.status === "starting" || session.status === "working" || session.status === "idle") {
          this.update(session, { status: "working", text: clip(text, 160) });
        }
      },
      said: (text) => this.update(session, { text: clip(text, 400) }),
      idle: (summary) => {
        if (session.status === "stopped" || session.status === "failed") return;
        const text = clip(summary ?? "Done.", 400);
        this.update(session, { status: "idle", text });
        this.options.emit({
          type: "notify",
          title: `${session.label} finished`,
          body: clip(text, 200),
          kind: "completion",
        });
      },
      fail: (message) => this.fail(session, message),
      ask: (request) => this.ask(session, request),
    };
  }

  /** Shows what the agent wants and waits. Anything but a clear yes is a no. */
  private async ask(session: AgentSession, request: AgentAsk): Promise<AgentAnswer> {
    this.update(session, { status: "needs_you", text: clip(request.title, 160) });
    try {
      const first = await this.show(session, request, "review");
      if (first.decision === "cancel") return { allow: false };
      if (request.kind === "question") {
        const answer = first.input && typeof first.input.answer === "string" ? first.input.answer.trim() : "";
        return { allow: true, text: answer };
      }
      if (request.risky) {
        // A command that could do real damage needs a second, separate yes.
        const second = await this.show(session, request, "confirm");
        if (second.decision === "cancel") return { allow: false };
      }
      return { allow: true };
    } finally {
      if (session.status === "needs_you") this.update(session, { status: "working", text: "Working…" });
    }
  }

  private async show(session: AgentSession, request: AgentAsk, stage: "review" | "confirm") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs?.() ?? 10 * 60_000);
    const preview = this.preview(session, request, stage);
    let outcome: "approved" | "cancelled" | "expired" = "cancelled";
    try {
      const response = await this.options.approvals.request(preview, controller.signal);
      outcome = controller.signal.aborted ? "expired" : response.decision === "cancel" ? "cancelled" : "approved";
      return response;
    } catch {
      // A timeout, a closed card, or a broken connection to the shell is a "no".
      outcome = controller.signal.aborted ? "expired" : "cancelled";
      return { decision: "cancel" as const };
    } finally {
      clearTimeout(timer);
      this.options.approvals.dismiss?.(preview.callId, outcome);
    }
  }

  private preview(session: AgentSession, request: AgentAsk, stage: "review" | "confirm"): Preview {
    const card: Card = {
      kind: "agent",
      icon: "agent",
      app: session.label,
      title: request.title,
      rows: [
        {
          icon: request.kind === "question" ? "text" : request.kind === "file" ? "folder" : "text",
          style: "body",
          values: [clip(request.detail, 300)],
        },
        ...(request.cwd ? [{ icon: "folder", style: "text" as const, values: [request.cwd] }] : []),
      ],
    };
    const isQuestion = request.kind === "question";
    return {
      callId: `agent-${session.id}-${++this.asks}`,
      tool: `agents.${session.kind}.ask`,
      displayName: session.label,
      icon: "agent",
      verb: isQuestion ? "Send" : request.kind === "file" ? "Save" : "Run",
      summary: `${request.title}: ${clip(request.detail, 100)}`,
      // Only a question can be edited. A command or file change is allowed or refused exactly as shown.
      fields: isQuestion ? [{ key: "answer", label: "Your answer", type: "longtext", value: "" }] : [],
      card,
      raw: { agent: session.kind, detail: request.detail },
      risk: request.risky ? "destructive" : "normal",
      state: "pending",
      stage,
      expiresAt: this.clock.now() + (this.options.timeoutMs?.() ?? 10 * 60_000),
    };
  }
}
