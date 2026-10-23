/** Speech-to-text: turns a recorded audio file into a transcript. */
export interface SttProvider {
  transcribe(audioPath: string): Promise<string>;
}

/** OS-level editing actions a spoken command can trigger. */
export type InjectorCommand = "undo" | "selectAll";

/** Where dictated or edited text ends up (focused text field, stdout, a test buffer...). */
export interface TextInjector {
  insert(text: string): Promise<void>;
  getSelection(): Promise<string>;
  replaceSelection(text: string): Promise<void>;
  /** Runs an editing command. Absent when the target cannot do it (for example the CLI's stdout). */
  command?(name: InjectorCommand): Promise<void>;
}

/** Describes what the user is working in; used to adapt formatting. */
export interface AppContext {
  appName?: string;
  /** Free-form hint such as "email", "chat", "code". */
  kind?: string;
  /** Text visible on screen, when a screen-context provider is available. */
  screenText?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** True only when the tool is known not to change anything. Unknown means false. */
  readOnly: boolean;
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
}

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
}

export interface LlmProvider {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** Executes tools on behalf of the agent (backed by MCP servers in production). */
export interface ToolHost {
  list(): Promise<ToolSpec[]>;
  call(name: string, input: Record<string, unknown>): Promise<string>;
  close?(): Promise<void>;
}

/** Asks the user before an action that may change something. Returns true to allow. */
export type ConfirmHandler = (action: { tool: string; input: Record<string, unknown> }) => Promise<boolean>;
