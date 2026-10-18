import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { AdapterHandle, AdapterSink, AgentAdapter, Detection } from "./types.js";
import { asObject, asString, detectBinary, findBinary, isRiskyCommand, terminate } from "./util.js";

type Obj = Record<string, unknown>;

/** A free port on this machine. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * OpenCode through its own local server (`opencode serve`): REST for sessions, a server-sent event stream for
 * progress, and `permission.asked` events answered with `POST /permission/{id}/reply`. The server listens on this
 * machine only and gets a random password. The shapes come from the OpenAPI spec of a running server; the
 * permission event has not been seen live yet.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly kind = "opencode" as const;
  readonly label = "OpenCode";

  constructor(private readonly binary?: string) {}

  detect(): Promise<Detection> {
    return detectBinary("opencode", "Run `opencode auth login` in a terminal if it isn't signed in.");
  }

  async start(options: { cwd: string; prompt: string }, sink: AdapterSink): Promise<AdapterHandle> {
    const path = this.binary ?? findBinary("opencode");
    if (!path) throw new Error("OpenCode isn't installed.");
    const port = await freePort();
    const password = randomBytes(18).toString("hex");
    const child = spawn(path, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--pure"], {
      cwd: options.cwd,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    });
    const session = new OpenCodeSession(child, port, password, options, sink);
    try {
      await session.begin();
    } catch (error) {
      await session.stop();
      throw error;
    }
    return session;
  }
}

class OpenCodeSession implements AdapterHandle {
  private sessionId = "";
  private stopped = false;
  private stderr = "";
  private readonly abort = new AbortController();
  private readonly text = new Map<string, string>();
  private lastText = "";

  constructor(
    private readonly child: ChildProcess,
    private readonly port: number,
    private readonly password: string,
    private readonly options: { cwd: string; prompt: string },
    private readonly sink: AdapterSink,
  ) {
    child.stderr?.on("data", (chunk: Buffer) => (this.stderr = (this.stderr + chunk.toString()).slice(-600)));
    child.on("error", (error) => sink.fail(`Couldn't start OpenCode: ${error.message}`));
    child.on("close", () => {
      if (!this.stopped)
        sink.fail(this.stderr.trim() ? `OpenCode stopped: ${this.stderr.trim()}` : "OpenCode stopped.");
    });
  }

  private url(path: string): string {
    const base = `http://127.0.0.1:${this.port}${path}`;
    return base + (base.includes("?") ? "&" : "?") + `directory=${encodeURIComponent(this.options.cwd)}`;
  }

  private headers(json = false): Record<string, string> {
    return {
      authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`,
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(this.url(path), {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: this.abort.signal,
    });
  }

  async begin(): Promise<void> {
    await this.waitUntilUp();
    const created = await this.request("POST", "/session", {
      title: "Murmur",
      // Anything that runs a command or changes a file asks first.
      permission: [
        { permission: "bash", pattern: "*", action: "ask" },
        { permission: "edit", pattern: "*", action: "ask" },
      ],
    });
    if (!created.ok) throw new Error(`OpenCode wouldn't start a session (${created.status}).`);
    this.sessionId = asString(asObject(await created.json()).id);
    if (!this.sessionId) throw new Error("OpenCode didn't start a session.");
    void this.listen();
    await this.send(this.options.prompt);
  }

  private async waitUntilUp(): Promise<void> {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/global/health`, {
          headers: this.headers(),
          signal: this.abort.signal,
        });
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      if (this.child.exitCode !== null) throw new Error(this.stderr.trim() || "OpenCode stopped while starting.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("OpenCode didn't start in time.");
  }

  async send(text: string): Promise<void> {
    this.sink.working("Thinking…");
    // The reply arrives when the work is done; progress comes over the event stream, so this is not awaited.
    void this.request("POST", `/session/${this.sessionId}/message`, { parts: [{ type: "text", text }] })
      .then(async (res) => {
        if (!res.ok) this.sink.fail(`OpenCode refused the request (${res.status}).`);
      })
      .catch((error: Error) => {
        if (!this.stopped) this.sink.fail(`OpenCode: ${error.message}`);
      });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sessionId) await this.request("POST", `/session/${this.sessionId}/abort`).catch(() => {});
    this.abort.abort();
    await terminate(this.child);
  }

  /** Reads the server-sent event stream until the session ends. */
  private async listen(): Promise<void> {
    try {
      const res = await fetch(this.url("/event"), { headers: this.headers(), signal: this.abort.signal });
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          if (data) this.event(data);
        }
      }
    } catch {
      /* aborted on stop */
    }
  }

  private event(data: string): void {
    let message: Obj;
    try {
      message = JSON.parse(data) as Obj;
    } catch {
      return;
    }
    const type = asString(message.type);
    const props = asObject(message.properties);
    const forThisSession = !props.sessionID || props.sessionID === this.sessionId;
    if (!forThisSession) return;
    if (type === "message.part.updated") {
      const part = asObject(props.part);
      if (part.type === "text" && asString(part.text)) {
        this.text.set(asString(part.id), asString(part.text));
        this.lastText = asString(part.text);
      } else if (part.type === "tool") {
        this.sink.working(`Using ${asString(part.tool, "a tool")}…`);
      }
    } else if (type === "message.part.delta" && asString(props.field) === "text") {
      const id = asString(props.partID);
      const next = (this.text.get(id) ?? "") + asString(props.delta);
      this.text.set(id, next);
      this.lastText = next;
    } else if (type === "permission.asked") {
      void this.permission(props);
    } else if (type === "question.asked") {
      void this.refuseQuestion(props);
    } else if (type === "session.idle") {
      if (this.lastText) this.sink.said(this.lastText);
      this.sink.idle(this.lastText || undefined);
      this.text.clear();
      this.lastText = "";
    } else if (type === "session.error") {
      const error = asObject(props.error);
      this.sink.fail(asString(asObject(error.data).message) || asString(error.name) || "OpenCode hit an error.");
    }
  }

  private async permission(props: Obj): Promise<void> {
    const id = asString(props.id);
    const kind = asString(props.permission);
    const patterns = Array.isArray(props.patterns) ? props.patterns.map(String).join(", ") : "";
    const isCommand = kind === "bash";
    let reply = "reject";
    try {
      const answer = await this.sink.ask({
        kind: isCommand ? "command" : kind === "edit" ? "file" : "other",
        title: isCommand
          ? "OpenCode wants to run a command"
          : kind === "edit"
            ? "OpenCode wants to change files"
            : `OpenCode wants permission: ${kind}`,
        detail: patterns || kind,
        cwd: this.options.cwd,
        risky: isCommand ? isRiskyCommand(patterns) : false,
      });
      // "once", never "always": Murmur does not hand out standing permission.
      reply = answer.allow ? "once" : "reject";
    } catch {
      reply = "reject";
    }
    await this.request("POST", `/permission/${encodeURIComponent(id)}/reply`, { reply }).catch(() => {});
  }

  private async refuseQuestion(props: Obj): Promise<void> {
    const id = asString(props.id);
    this.sink.said("OpenCode asked a question Murmur can't answer yet. It was declined.");
    await this.request("POST", `/question/${encodeURIComponent(id)}/reject`).catch(() => {});
  }
}
