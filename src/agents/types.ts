export type AgentKind = "codex" | "claude" | "opencode";

export type AgentStatus = "starting" | "working" | "needs_you" | "idle" | "failed" | "stopped";

/** What an agent wants from the user, in words the notch can show. */
export interface AgentAsk {
  kind: "command" | "file" | "question" | "other";
  /** One line: "Codex wants to run a command". */
  title: string;
  /** The command, the file, or the question. Shown as plain text. */
  detail: string;
  /** Folder it will work in. */
  cwd?: string;
  /** Set when the thing is risky enough to need a second confirmation. */
  risky?: boolean;
}

export interface AgentAnswer {
  allow: boolean;
  /** For a question: what the user typed. */
  text?: string;
}

/** How an adapter reports back to the hub. */
export interface AdapterSink {
  /** The agent is doing something: "Running: npm test". */
  working(text: string): void;
  /** The agent said something. The last one is the summary when a turn ends. */
  said(text: string): void;
  /** The agent stopped and needs the user. Resolves with the answer. */
  ask(request: AgentAsk): Promise<AgentAnswer>;
  /** A turn finished; the agent is waiting for the next instruction. */
  idle(summary?: string): void;
  fail(message: string): void;
}

export interface AdapterHandle {
  /** A follow-up for the same session. */
  send(text: string): Promise<void>;
  /** Stops the current work and shuts the agent down. */
  stop(): Promise<void>;
}

export interface Detection {
  installed: boolean;
  version?: string;
  path?: string;
  /** What to do when it isn't ready: "Run `claude auth login`". */
  hint?: string;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  readonly label: string;
  detect(): Promise<Detection>;
  start(options: { cwd: string; prompt: string }, sink: AdapterSink): Promise<AdapterHandle>;
}

export interface AgentSession {
  id: string;
  kind: AgentKind;
  label: string;
  cwd: string;
  task: string;
  status: AgentStatus;
  /** What it is doing now, or what it last said. */
  text: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}
