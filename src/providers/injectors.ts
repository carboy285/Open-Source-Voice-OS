import type { TextInjector } from "../core/types.js";

/** Prints text to a stream; the selection is supplied up front. Used by the CLI. */
export class StdoutInjector implements TextInjector {
  constructor(
    private readonly selection = "",
    private readonly out: { write(chunk: string): unknown } = process.stdout,
  ) {}

  async insert(text: string): Promise<void> {
    this.out.write(`${text}\n`);
  }

  async getSelection(): Promise<string> {
    return this.selection;
  }

  async replaceSelection(text: string): Promise<void> {
    this.out.write(`${text}\n`);
  }
}

/** Keeps a document in memory; handy for tests and for embedding in other UIs. */
export class MemoryInjector implements TextInjector {
  constructor(
    public text = "",
    public selection = "",
  ) {}

  async insert(text: string): Promise<void> {
    this.text += text;
  }

  async getSelection(): Promise<string> {
    return this.selection;
  }

  async replaceSelection(text: string): Promise<void> {
    this.text = this.selection ? this.text.replace(this.selection, text) : this.text + text;
    this.selection = text;
  }
}
