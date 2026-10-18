/** Mono 16 kHz signed 16-bit little-endian PCM, held only in memory. */
export interface Pcm16Audio {
  pcm: Uint8Array;
  sampleRate: number;
}

export interface TranscribeOptions {
  /** Vocabulary hint (whisper "initial prompt"). */
  prompt?: string;
  /** Pinned language code, or undefined to auto-detect. */
  language?: string;
}

export interface Transcript {
  text: string;
  /** Detected language code when the provider reports it. */
  language?: string;
}

/** Speech-to-text. Audio never touches the disk. */
export interface SttProvider {
  transcribe(audio: Pcm16Audio, options?: TranscribeOptions): Promise<Transcript>;
}

/** Where dictated or edited text ends up (focused text field, stdout, a test buffer...). */
export interface TextInjector {
  insert(text: string): Promise<void>;
  getSelection(): Promise<string>;
  replaceSelection(text: string): Promise<void>;
}

/** What the user is working in, as reported by the shell's `context.capture`. */
export interface AppContext {
  appId?: string;
  appName?: string;
  windowTitle?: string;
  /** Accessibility role of the focused element. */
  role?: string;
  /** App category (see tone.ts). Derived from the fields above when missing. */
  kind?: string;
  selection?: string;
  underPointer?: string;
  focusedText?: string;
  /** Legacy single field for on-screen text. */
  screenText?: string;
}

/** Side-effect flags a built-in connector action declares. */
export interface SideEffects {
  readOnly?: boolean;
  sends?: boolean;
  books?: boolean;
  modifies?: boolean;
  destructive?: boolean;
}

/** MCP tool annotations. Hints only; they can add gating but never remove it from a built-in. */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type FieldType = "text" | "longtext" | "datetime" | "recipients" | "path";
export type Verb = "Send" | "Book" | "Save" | "Rename" | "Move" | "Delete" | "Run";

export interface FieldHint {
  label?: string;
  type?: FieldType;
}

/** Connector-supplied preview helpers. Never produced by the model. */
export interface PreviewHints {
  summarize(input: Record<string, unknown>): string;
  verb?: Verb;
  fields?: Record<string, FieldHint>;
  icon?: string;
  displayName?: string;
}

export type ToolOrigin = "builtin" | "mcp" | "unknown";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Where the side-effect metadata comes from. Decides how the gate reads it. */
  origin: ToolOrigin;
  effects?: SideEffects;
  annotations?: McpToolAnnotations;
  preview?: PreviewHints;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

export interface LlmRequest {
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
}

export interface LlmProvider {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** Executes tools on behalf of the agent (connectors and MCP servers). */
export interface ToolHost {
  list(): Promise<ToolSpec[]>;
  call(name: string, input: Record<string, unknown>): Promise<string>;
  close?(): Promise<void>;
}

/** Injectable time source for timeouts and schedules. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
