import { randomUUID } from "node:crypto";
import type { AppContext, Clock, LlmProvider, ToolHost } from "../core/types.js";
import { systemClock } from "../core/types.js";
import { ApprovalGate, type ApprovalUi } from "../gate/gate.js";
import { runAgent, type AgentOutcome } from "../modes/agent.js";
import type { Conversation } from "../modes/conversation.js";
import { MemoryTaskStore, type TaskRecord, type TaskStatus, type TaskStore } from "./types.js";

export interface TaskUpdate {
  taskId: string;
  status: TaskStatus;
  steps: TaskRecord["steps"];
  /** True once the task passed 3 tool steps or 10 seconds; the shell moves it to the side panel. */
  long: boolean;
  reply?: string;
  currentStep?: string;
}

export interface TaskRunnerOptions {
  llm: () => LlmProvider | undefined | Promise<LlmProvider | undefined>;
  tools: ToolHost;
  approvals: ApprovalUi;
  store?: TaskStore;
  clock?: Clock;
  saveTranscripts?: () => boolean;
  /** IANA zone of the user; the agent is told the date and time in it. */
  timeZone?: () => string;
  /** What the agent remembers between requests. Without it every request starts from nothing. */
  conversation?: Conversation;
  /** BCP 47 locale for dates on approval cards. */
  locale?: () => string;
  limits?: () => { maxSteps?: number; maxWallMs?: number; approvalTimeoutMs?: number };
  onUpdate?: (update: TaskUpdate) => void;
  /** Called when a long task ends, so the shell can post a system notification. */
  notify?: (status: TaskStatus, reply: string) => void;
  longAfterSteps?: number;
  longAfterMs?: number;
}

interface Live {
  record: TaskRecord;
  controller: AbortController;
  transcript: string;
  context?: AppContext;
  long: boolean;
  done: Promise<TaskRecord>;
}

/** Runs agent tasks, reports status changes, persists history and supports cancel and run-again. */
export class TaskRunner {
  private readonly live = new Map<string, Live>();
  /** Requests kept in memory for run-again, even when transcripts are not saved. */
  private readonly recent = new Map<string, { transcript: string; context?: AppContext }>();
  private readonly store: TaskStore;
  private readonly clock: Clock;

  constructor(private readonly options: TaskRunnerOptions) {
    this.store = options.store ?? new MemoryTaskStore();
    this.clock = options.clock ?? systemClock;
  }

  start(transcript: string, context?: AppContext): { taskId: string; done: Promise<TaskRecord> } {
    const id = randomUUID();
    const save = this.options.saveTranscripts?.() ?? false;
    const record: TaskRecord = {
      id,
      status: "running",
      transcript: save ? transcript : null,
      reply: "",
      startedAt: this.clock.now(),
      finishedAt: null,
      steps: [],
    };
    const controller = new AbortController();
    const entry = { record, controller, transcript, context, long: false } as Live;
    this.live.set(id, entry);
    this.recent.set(id, { transcript, context });
    if (this.recent.size > 50) this.recent.delete(this.recent.keys().next().value!);
    this.store.save(record);
    entry.done = this.execute(entry);
    return { taskId: id, done: entry.done };
  }

  /** Stops before the next tool call. A tool call already running finishes. */
  cancel(taskId: string): boolean {
    const entry = this.live.get(taskId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  /** Starts a new task with the same request. Works while the transcript is in memory or saved. */
  runAgain(taskId: string): { taskId: string; done: Promise<TaskRecord> } | undefined {
    const recent = this.recent.get(taskId);
    const transcript = recent?.transcript ?? this.store.get(taskId)?.transcript;
    if (!transcript) return undefined;
    return this.start(transcript, recent?.context);
  }

  get(taskId: string): TaskRecord | undefined {
    return this.live.get(taskId)?.record ?? this.store.get(taskId);
  }

  list(options?: { limit?: number; query?: string }): TaskRecord[] {
    return this.store.list(options);
  }

  private async execute(entry: Live): Promise<TaskRecord> {
    const { record } = entry;
    let llm: LlmProvider | undefined;
    try {
      llm = await this.options.llm();
    } catch (error) {
      return this.finish(entry, "failed", error instanceof Error ? error.message : String(error));
    }
    if (!llm) return this.finish(entry, "failed", "Agent mode needs a model. Add one in Settings.");
    const limits = this.options.limits?.() ?? {};
    const longAfterMs = this.options.longAfterMs ?? 10_000;
    const timer = setTimeout(() => this.markLong(entry), longAfterMs);
    timer.unref?.();
    const gate = new ApprovalGate(this.options.approvals, {
      timeoutMs: limits.approvalTimeoutMs,
      clock: this.clock,
      timeZone: this.options.timeZone?.(),
      locale: this.options.locale?.(),
      onState: (_callId, state) => {
        if (entry.controller.signal.aborted) return;
        if (state === "pending" || state === "edited") this.setStatus(entry, "waiting_approval");
        else if (record.status === "waiting_approval") this.setStatus(entry, "running");
      },
    });

    let outcome: AgentOutcome;
    try {
      outcome = await runAgent(entry.transcript, llm, this.options.tools, gate, {
        context: entry.context,
        clock: this.clock,
        timeZone: this.options.timeZone?.(),
        history: this.options.conversation?.messages(),
        signal: entry.controller.signal,
        maxSteps: limits.maxSteps,
        maxWallMs: limits.maxWallMs,
        onEvent: (event) => {
          if (event.type === "tool_start") this.emit(entry, event.call.name);
          if (event.type === "tool_end") {
            record.steps.push(event.record);
            if (record.steps.length > (this.options.longAfterSteps ?? 3)) entry.long = true;
            this.store.save(record);
            this.emit(entry);
          }
        },
      });
    } catch (error) {
      clearTimeout(timer);
      return this.finish(entry, "failed", error instanceof Error ? error.message : String(error));
    }
    clearTimeout(timer);
    if (outcome.status !== "cancelled" && outcome.status !== "failed" && outcome.reply) {
      this.options.conversation?.add({ request: entry.transcript, reply: outcome.reply, actions: outcome.trace });
    }
    const status: TaskStatus =
      outcome.status === "done" ? "done" : outcome.status === "cancelled" ? "cancelled" : "failed";
    return this.finish(entry, status, outcome.reply);
  }

  private markLong(entry: Live): void {
    if (entry.long || entry.record.finishedAt !== null) return;
    entry.long = true;
    this.emit(entry);
  }

  private setStatus(entry: Live, status: TaskStatus): void {
    if (entry.record.status === status) return;
    entry.record.status = status;
    this.store.save(entry.record);
    this.emit(entry);
  }

  private emit(entry: Live, currentStep?: string): void {
    this.options.onUpdate?.({
      taskId: entry.record.id,
      status: entry.record.status,
      steps: structuredClone(entry.record.steps),
      long: entry.long,
      reply: entry.record.reply || undefined,
      currentStep,
    });
  }

  private finish(entry: Live, status: TaskStatus, reply: string): TaskRecord {
    const { record } = entry;
    record.status = status;
    record.reply = reply;
    record.finishedAt = this.clock.now();
    this.store.save(record);
    this.emit(entry);
    if (entry.long) this.options.notify?.(status, reply);
    this.live.delete(record.id);
    return structuredClone(record);
  }
}
