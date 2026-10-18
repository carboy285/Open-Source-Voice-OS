import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmProvider, LlmRequest, LlmResponse, Message, ToolCall, ToolSpec } from "../core/types.js";

export interface CodexRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the codex binary with a prompt on stdin. Replaceable so tests need no real Codex. */
export type CodexRunner = (args: string[], stdin: string, options: { cwd: string }) => Promise<CodexRunResult>;

export const DEFAULT_TIMEOUT_MS = 120_000;

export const spawnCodex = (binary: string, timeoutMs = DEFAULT_TIMEOUT_MS): CodexRunner => (args, stdin, { cwd }) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    // Codex retries unreachable networks for a long time; give up instead of hanging the assistant.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Codex did not answer within ${Math.round(timeoutMs / 1000)}s. Check your network and sign-in ("voiceos status").`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === "ENOENT"
          ? new Error(`Could not find "${binary}". Install Codex (npm i -g @openai/codex) and run "voiceos login".`)
          : error,
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });

/** JSON shape Codex must answer with. Tool input travels as a JSON string to satisfy strict structured outputs. */
export const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text", "tool_calls"],
  properties: {
    text: { type: "string" },
    tool_calls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "input_json"],
        properties: { name: { type: "string" }, input_json: { type: "string" } },
      },
    },
  },
} as const;

function renderTools(tools: ToolSpec[]): string {
  return tools
    .map((tool) => `- ${tool.name}: ${tool.description}\n  input schema: ${JSON.stringify(tool.inputSchema)}`)
    .join("\n");
}

function renderMessages(messages: Message[]): string {
  return messages
    .map((message) => {
      switch (message.role) {
        case "user":
          return `[user]\n${message.text}`;
        case "assistant":
          return [
            message.text ? `[assistant]\n${message.text}` : "",
            ...message.toolCalls.map((c) => `[assistant tool call ${c.id}] ${c.name} ${JSON.stringify(c.input)}`),
          ]
            .filter(Boolean)
            .join("\n");
        case "tool":
          return message.results
            .map((r) => `[tool result ${r.id}${r.isError ? " (error)" : ""}]\n${r.content}`)
            .join("\n");
      }
    })
    .join("\n\n");
}

/** Builds the single prompt sent to Codex. Exported for testing. */
export function buildPrompt(request: LlmRequest): string {
  const tools = request.tools?.length ? request.tools : undefined;
  return [
    request.system,
    "Answer ONLY with a JSON object matching the provided schema. Do not run shell commands or edit files yourself.",
    tools
      ? `You can request tools. To use one, add an entry to tool_calls with its exact name and its arguments as a JSON string in input_json. Request no tool_calls when you are done; put your reply in text.\n\nTools:\n${renderTools(tools)}`
      : "You have no tools: leave tool_calls empty and put your reply in text.",
    `Conversation so far:\n${renderMessages(request.messages)}`,
  ].join("\n\n");
}

function stripFences(raw: string): string {
  const match = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match?.[1] ?? raw.trim();
}

/** Parses Codex's final message into an LlmResponse. Exported for testing. */
export function parseResponse(raw: string, nextId: () => string): LlmResponse {
  let data: { text?: unknown; tool_calls?: unknown };
  try {
    data = JSON.parse(stripFences(raw));
  } catch {
    // The model ignored the schema: treat its message as a plain reply.
    return { text: raw.trim(), toolCalls: [] };
  }
  const toolCalls: ToolCall[] = [];
  for (const entry of Array.isArray(data.tool_calls) ? data.tool_calls : []) {
    const { name, input_json } = entry as { name?: unknown; input_json?: unknown };
    if (typeof name !== "string") continue;
    let input: Record<string, unknown> = {};
    if (typeof input_json === "string" && input_json.trim()) {
      const parsed: unknown = JSON.parse(input_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
    }
    toolCalls.push({ id: nextId(), name, input });
  }
  return { text: typeof data.text === "string" ? data.text : "", toolCalls };
}

export interface CodexOptions {
  binary?: string;
  model?: string;
  timeoutMs?: number;
  runner?: CodexRunner;
}

/**
 * Uses the user's own Codex CLI as the model, so a ChatGPT plan works after `codex login`.
 * This app never reads or stores Codex credentials: Codex holds the sign-in and makes the API calls.
 * Each call is a fresh, ephemeral, read-only Codex run with the user's Codex config ignored.
 */
export class CodexCliLlm implements LlmProvider {
  private readonly runner: CodexRunner;
  private counter = 0;

  constructor(private readonly options: CodexOptions = {}) {
    this.runner = options.runner ?? spawnCodex(options.binary ?? "codex", options.timeoutMs);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const dir = await mkdtemp(join(tmpdir(), "voiceos-codex-"));
    try {
      const schemaPath = join(dir, "schema.json");
      const outputPath = join(dir, "last-message.txt");
      await writeFile(schemaPath, JSON.stringify(RESPONSE_SCHEMA));
      const args = [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "-s",
        "read-only",
        "-C",
        dir,
        "--output-schema",
        schemaPath,
        "-o",
        outputPath,
        ...(this.options.model ? ["-m", this.options.model] : []),
        "-",
      ];
      const result = await this.runner(args, buildPrompt(request), { cwd: dir });
      if (result.code !== 0) {
        const detail = result.stderr.trim().split("\n").slice(-5).join("\n");
        throw new Error(`Codex exited with code ${result.code}. If you are not signed in, run "voiceos login".\n${detail}`);
      }
      const raw = await readFile(outputPath, "utf8");
      return parseResponse(raw, () => `codex_${++this.counter}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Passes through to `codex login` / `codex login status` so the user signs in with ChatGPT. */
export function codexAuth(binary = "codex", runner: typeof spawn = spawn): {
  login(): Promise<number>;
  status(): Promise<{ loggedIn: boolean; detail: string }>;
} {
  return {
    login: () =>
      new Promise((resolve, reject) => {
        const child = runner(binary, ["login"], { stdio: "inherit" });
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? 1));
      }),
    status: () =>
      new Promise((resolve, reject) => {
        const child = runner(binary, ["login", "status"], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout?.on("data", (c: Buffer) => (out += c));
        child.stderr?.on("data", (c: Buffer) => (out += c));
        child.on("error", reject);
        child.on("close", (code) => resolve({ loggedIn: code === 0, detail: out.trim() }));
      }),
  };
}
