import type { ToolHost, ToolSpec } from "../../src/core/types.js";

/** Records every call that reaches the host. */
export class RecordingToolHost implements ToolHost {
  readonly calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  constructor(private readonly specs: ToolSpec[]) {}
  async list(): Promise<ToolSpec[]> {
    return this.specs;
  }
  async call(name: string, input: Record<string, unknown>): Promise<string> {
    this.calls.push({ name, input: structuredClone(input) });
    return `ok:${name}`;
  }
}

const schema = (props: Record<string, unknown>, required: string[] = Object.keys(props)) => ({
  type: "object",
  properties: props,
  required,
});

export const sendEmail: ToolSpec = {
  name: "gmail.send",
  description: "Send an email",
  origin: "builtin",
  effects: { sends: true },
  inputSchema: schema({
    to: { type: "array", items: { type: "string" } },
    subject: { type: "string" },
    body: { type: "string" },
  }),
  preview: { summarize: (i) => `Email to ${(i.to as string[]).join(", ")}: "${String(i.subject)}"`, verb: "Send" },
};

export const bookEvent: ToolSpec = {
  name: "calendar.create_event",
  description: "Create an event",
  origin: "builtin",
  effects: { books: true },
  inputSchema: schema({ title: { type: "string" }, start: { type: "string", format: "date-time" } }),
  preview: { summarize: (i) => `Event "${String(i.title)}" at ${String(i.start)}`, verb: "Book" },
};

export const renameFile: ToolSpec = {
  name: "files.rename",
  description: "Rename a file",
  origin: "builtin",
  effects: { modifies: true },
  inputSchema: schema({ path: { type: "string" }, newName: { type: "string" } }),
  preview: { summarize: (i) => `Rename ${String(i.path)} to ${String(i.newName)}`, verb: "Rename" },
};

export const deleteFile: ToolSpec = {
  name: "files.delete",
  description: "Delete a file",
  origin: "builtin",
  effects: { modifies: true, destructive: true },
  inputSchema: schema({ path: { type: "string" } }),
  preview: { summarize: (i) => `Delete ${String(i.path)}`, verb: "Delete" },
};

export const searchFiles: ToolSpec = {
  name: "files.search",
  description: "Search files",
  origin: "builtin",
  effects: { readOnly: true },
  inputSchema: schema({ query: { type: "string" } }),
  preview: { summarize: (i) => `Search for ${String(i.query)}` },
};
