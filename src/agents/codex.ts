import { spawn, type ChildProcess } from "node:child_process";
import { VERSION } from "../core/version.js";
import type { AdapterHandle, AdapterSink, AgentAdapter, Detection } from "./types.js";
import {
  asObject,
  asString,
  detectBinary,
  findBinary,
  isRiskyCommand,
  parseJson,
  readLines,
  terminate,
} from "./util.js";

type Obj = Record<string, unknown>;

/**
 * Codex through `codex app-server`: JSON-RPC over stdio, with approvals as requests from the server.
 * The method names and shapes come from the schema `codex app-server generate-json-schema` writes, and from
 * a live run: the approval request itself has not been seen against the user's own Codex yet.
 */
export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  readonly label = "Codex";

  constructor(private readonly binary?: string) {}

  detect(): Promise<Detection> {
    return detectBinary("codex", "Run `codex login` in a terminal if it isn't signed in.");
  }

  async start(options: { cwd: string; prompt: string }, sink: AdapterSink): Promise<AdapterHandle> {
    const path = this.binary ?? findBinary("codex");
    if (!path) throw new Error("Codex isn't installed.");
    // The override applies to this one process only: approvals go to Murmur, and the user's own config stays as it is.
    const child = spawn(path, ["-c", 'approvals_reviewer="user"', "app-server", "--listen", "stdio://"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      return await new CodexSession(child, options, sink).begin();
    } catch (error) {
      await terminate(child);
      throw error;
    }
  }
}

class CodexSession implements AdapterHandle {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: Obj) => void; reject: (e: Error) => void }>();
  private threadId = "";
  private turnId = "";
  private working = false;
  private lastSaid = "";
  private stopped = false;
  private stderr = "";

  constructor(
    private readonly child: ChildProcess,
    private readonly options: { cwd: string; prompt: string },
    private readonly sink: AdapterSink,
  ) {
    child.stderr?.on("data", (chunk: Buffer) => (this.stderr = (this.stderr + chunk.toString()).slice(-600)));
    // Writing to a program that has already quit must not crash Murmur.
    child.stdin?.on("error", () => {});
    readLines(child, (line) => this.receive(line));
    child.on("error", (error) => this.sink.fail(`Couldn't start Codex: ${error.message}`));
    child.on("close", () => {
      for (const [, waiter] of this.pending) waiter.reject(new Error("Codex closed."));
      this.pending.clear();
      if (!this.stopped) this.sink.fail(this.stderr.trim() ? `Codex stopped: ${this.stderr.trim()}` : "Codex stopped.");
    });
  }

  async begin(): Promise<AdapterHandle> {
    await this.call("initialize", { clientInfo: { name: "murmur", title: "Murmur", version: VERSION } });
    this.notify("initialized", {});
    const started = await this.call("thread/start", {
      cwd: this.options.cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    this.threadId = asString(asObject(started.thread).id);
    if (!this.threadId) throw new Error("Codex didn't start a conversation.");
    await this.turn(this.options.prompt);
    return this;
  }

  private write(message: Obj): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private call(method: string, params: Obj): Promise<Obj> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex didn't answer ${method}.`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      this.write({ id, method, params });
    });
  }

  private notify(method: string, params: Obj): void {
    this.write({ method, params });
  }

  private async turn(text: string): Promise<void> {
    this.working = true;
    this.sink.working("Thinking…");
    const result = await this.call("turn/start", { threadId: this.threadId, input: [{ type: "text", text }] });
    this.turnId = asString(asObject(result.turn).id) || this.turnId;
  }

  async send(text: string): Promise<void> {
    if (this.working) throw new Error("Codex is still working. Ask again when it finishes.");
    await this.turn(text);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.working && this.threadId) {
      void this.call("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await terminate(this.child);
  }

  private receive(line: string): void {
    const message = parseJson(line);
    if (!message) return;
    const method = asString(message.method);
    const id = message.id;
    if (!method && typeof id === "number") {
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      const error = asObject(message.error);
      if (Object.keys(error).length) waiter.reject(new Error(asString(error.message, "Codex reported an error.")));
      else waiter.resolve(asObject(message.result));
      return;
    }
    const params = asObject(message.params);
    if (id !== undefined && method) void this.serverRequest(id as number | string, method, params);
    else if (method) this.notification(method, params);
  }

  private notification(method: string, params: Obj): void {
    const item = asObject(params.item);
    if (method === "item/started" && item.type === "commandExecution") {
      this.sink.working(`Running: ${asString(item.command).slice(0, 120)}`);
    } else if (method === "item/started" && item.type === "fileChange") {
      this.sink.working("Changing files…");
    } else if (method === "item/completed" && item.type === "agentMessage") {
      this.lastSaid = asString(item.text) || this.lastSaid;
      if (this.lastSaid) this.sink.said(this.lastSaid);
    } else if (method === "turn/completed") {
      this.working = false;
      this.sink.idle(this.lastSaid || undefined);
    } else if (method === "turn/failed" || method === "error") {
      this.working = false;
      const detail = asString(asObject(params.error).message) || asString(params.message);
      this.sink.fail(detail || "Codex hit an error.");
    }
  }

  private reply(id: number | string, result: Obj): void {
    this.write({ id, result });
  }

  private async serverRequest(id: number | string, method: string, params: Obj): Promise<void> {
    try {
      if (method === "item/commandExecution/requestApproval") {
        const command = asString(params.command);
        const answer = await this.sink.ask({
          kind: "command",
          title: "Codex wants to run a command",
          detail: command,
          cwd: asString(params.cwd) || this.options.cwd,
          risky: isRiskyCommand(command),
        });
        this.reply(id, { decision: answer.allow ? "accept" : "decline" });
      } else if (method === "item/fileChange/requestApproval") {
        const answer = await this.sink.ask({
          kind: "file",
          title: "Codex wants to change files",
          detail: asString(params.reason) || "Edit files in the project folder.",
          cwd: this.options.cwd,
        });
        this.reply(id, { decision: answer.allow ? "accept" : "decline" });
      } else {
        // Questions, extra permissions and MCP input: Murmur can't answer these yet, so say no rather than guess.
        const what = method.split("/").slice(-2).join(" ");
        this.sink.said(`Codex asked for something Murmur can't answer yet (${what}). It was declined.`);
        this.write({ id, error: { code: -32601, message: "Not supported by Murmur yet." } });
      }
    } catch {
      this.write({ id, result: { decision: "decline" } });
    }
  }
}
