import { spawn, type ChildProcess } from "node:child_process";
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
 * Claude Code in its streaming mode: JSON lines in and out. When a tool needs permission the CLI sends a
 * `control_request` (`can_use_tool`) and waits for a `control_response`. The wire format was read from the
 * installed binary, not yet run against a signed-in Claude Code, so a first run may need a small fix.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly kind = "claude" as const;
  readonly label = "Claude Code";

  constructor(private readonly binary?: string) {}

  detect(): Promise<Detection> {
    return detectBinary("claude", "Run `claude auth login` in a terminal if it isn't signed in.");
  }

  async start(options: { cwd: string; prompt: string }, sink: AdapterSink): Promise<AdapterHandle> {
    const path = this.binary ?? findBinary("claude");
    if (!path) throw new Error("Claude Code isn't installed.");
    const child = spawn(
      path,
      [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        // Permission questions come to Murmur, not a terminal that isn't there.
        "--permission-prompts",
        "host",
      ],
      { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] },
    );
    const session = new ClaudeSession(child, options.cwd, sink);
    session.say(options.prompt);
    return session;
  }
}

class ClaudeSession implements AdapterHandle {
  private lastText = "";
  private stopped = false;
  private stderr = "";

  constructor(
    private readonly child: ChildProcess,
    private readonly cwd: string,
    private readonly sink: AdapterSink,
  ) {
    child.stderr?.on("data", (chunk: Buffer) => (this.stderr = (this.stderr + chunk.toString()).slice(-600)));
    readLines(child, (line) => this.receive(line));
    child.on("error", (error) => sink.fail(`Couldn't start Claude Code: ${error.message}`));
    child.on("close", () => {
      if (!this.stopped)
        sink.fail(this.stderr.trim() ? `Claude Code stopped: ${this.stderr.trim()}` : "Claude Code stopped.");
    });
  }

  private write(message: Obj): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  /** A user message on the stream. */
  say(text: string): void {
    this.sink.working("Thinking…");
    this.write({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
  }

  async send(text: string): Promise<void> {
    this.say(text);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.child.stdin?.end();
    await terminate(this.child);
  }

  private receive(line: string): void {
    const message = parseJson(line);
    if (!message) return;
    const type = asString(message.type);
    if (type === "control_request") {
      void this.control(message);
    } else if (type === "assistant") {
      const content = asObject(message.message).content;
      for (const block of Array.isArray(content) ? content : []) {
        const b = asObject(block);
        if (b.type === "text" && asString(b.text)) {
          this.lastText = asString(b.text);
          this.sink.said(this.lastText);
        } else if (b.type === "tool_use") {
          this.sink.working(`Using ${asString(b.name, "a tool")}…`);
        }
      }
    } else if (type === "result") {
      if (message.is_error === true || asString(message.subtype).startsWith("error")) {
        this.sink.fail(asString(message.result) || "Claude Code reported an error.");
      } else {
        this.sink.idle(asString(message.result) || this.lastText || undefined);
      }
    }
  }

  private async control(message: Obj): Promise<void> {
    const requestId = asString(message.request_id);
    const request = asObject(message.request);
    const respond = (response: Obj) =>
      this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
    if (request.subtype !== "can_use_tool") {
      this.write({
        type: "control_response",
        response: { subtype: "error", request_id: requestId, error: "Not supported by Murmur." },
      });
      return;
    }
    const tool = asString(request.tool_name, "a tool");
    const input = asObject(request.input);
    const command = asString(input.command);
    const file = asString(input.file_path) || asString(input.path);
    const detail = command || file || JSON.stringify(input).slice(0, 300);
    try {
      const answer = await this.sink.ask({
        kind: command ? "command" : file ? "file" : "other",
        title: command
          ? "Claude Code wants to run a command"
          : file
            ? "Claude Code wants to change a file"
            : `Claude Code wants to use ${tool}`,
        detail,
        cwd: this.cwd,
        risky: command ? isRiskyCommand(command) : false,
      });
      // The input goes back exactly as it came: the user approves what they saw, never an edited command.
      if (answer.allow) respond({ behavior: "allow", updatedInput: input });
      else respond({ behavior: "deny", message: "The user said no in Murmur." });
    } catch {
      respond({ behavior: "deny", message: "Murmur couldn't ask the user." });
    }
  }
}
