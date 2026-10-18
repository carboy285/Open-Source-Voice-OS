import type { Readable, Writable } from "node:stream";

/** JSON-RPC 2.0 error codes used by Murmur. */
export const RpcErrors = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  app: -32000,
} as const;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Handler = (params: Record<string, unknown>) => unknown;
type Id = number | string;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Newline-delimited JSON-RPC 2.0 over a pair of streams. Both sides can send requests
 * and notifications, so the same class runs in the core and in test shells.
 */
export class JsonRpcPeer {
  private readonly handlers = new Map<string, Handler>();
  private readonly listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();
  private readonly pending = new Map<Id, Pending>();
  private nextId = 1;
  private buffer = "";
  private closed = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly onError: (error: Error) => void = () => {},
  ) {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.receive(chunk));
    input.on("end", () => this.close());
  }

  /** Registers a request handler. Its return value (or thrown RpcError) becomes the response. */
  handle(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  /** Listens for a notification. */
  on(method: string, listener: (params: Record<string, unknown>) => void): this {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
    return this;
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError(RpcErrors.internal, "Connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(RpcErrors.internal, `${method} timed out`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new RpcError(RpcErrors.internal, "Connection closed"));
    }
    this.pending.clear();
  }

  private write(message: unknown): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) void this.dispatch(line);
    }
  }

  private async dispatch(line: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.write({ jsonrpc: "2.0", id: null, error: { code: RpcErrors.parse, message: "Parse error" } });
      return;
    }
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
      this.write({ jsonrpc: "2.0", id: null, error: { code: RpcErrors.invalidRequest, message: "Invalid request" } });
      return;
    }
    const id = message.id as Id | undefined | null;

    if (typeof message.method !== "string") {
      if (id === undefined || id === null) return;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      const error = message.error as { code: number; message: string; data?: unknown } | undefined;
      if (error) entry.reject(new RpcError(error.code, error.message, error.data));
      else entry.resolve(message.result);
      return;
    }

    const params = (message.params ?? {}) as Record<string, unknown>;
    if (id === undefined || id === null) {
      for (const listener of this.listeners.get(message.method) ?? []) {
        try {
          listener(params);
        } catch (error) {
          this.onError(error as Error);
        }
      }
      return;
    }
    const handler = this.handlers.get(message.method);
    if (!handler) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: RpcErrors.methodNotFound, message: `Unknown method ${message.method}` },
      });
      return;
    }
    try {
      const result = await handler(params);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      const rpc =
        error instanceof RpcError ? error : new RpcError(RpcErrors.app, (error as Error)?.message ?? String(error));
      if (!(error instanceof RpcError)) this.onError(error as Error);
      this.write({ jsonrpc: "2.0", id, error: { code: rpc.code, message: rpc.message, data: rpc.data } });
    }
  }
}
