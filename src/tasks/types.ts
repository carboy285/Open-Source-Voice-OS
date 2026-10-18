import type { StepRecord } from "../modes/agent.js";

export type TaskStatus = "running" | "waiting_approval" | "done" | "failed" | "cancelled";

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  /** null unless history.saveTranscripts is on. Shown as "—". */
  transcript: string | null;
  reply: string;
  startedAt: number;
  finishedAt: number | null;
  steps: StepRecord[];
}

export interface TaskStore {
  save(task: TaskRecord): void;
  get(id: string): TaskRecord | undefined;
  list(options?: { limit?: number; query?: string }): TaskRecord[];
  prune(before: number): void;
}

export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  save(task: TaskRecord): void {
    this.tasks.set(task.id, structuredClone(task));
  }
  get(id: string): TaskRecord | undefined {
    const task = this.tasks.get(id);
    return task && structuredClone(task);
  }
  list(options: { limit?: number; query?: string } = {}): TaskRecord[] {
    const q = options.query?.toLowerCase();
    return [...this.tasks.values()]
      .filter((t) => !q || matches(t, q))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, options.limit ?? 50)
      .map((t) => structuredClone(t));
  }
  prune(before: number): void {
    for (const [id, task] of this.tasks) if (task.startedAt < before) this.tasks.delete(id);
  }
}

export function matches(task: TaskRecord, q: string): boolean {
  return [task.transcript ?? "", task.reply, ...task.steps.map((s) => `${s.tool} ${s.inputSummary}`)].some((s) =>
    s.toLowerCase().includes(q),
  );
}
