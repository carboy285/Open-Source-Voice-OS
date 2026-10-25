import type { ToolHost, ToolSpec } from "../core/types.js";

/** Merges several tool hosts into one. The first host that lists a tool name owns it. */
export class CompositeToolHost implements ToolHost {
  private owners = new Map<string, ToolHost>();

  constructor(private readonly hosts: ToolHost[]) {}

  async list(): Promise<ToolSpec[]> {
    const specs: ToolSpec[] = [];
    this.owners.clear();
    for (const host of this.hosts) {
      for (const spec of await host.list()) {
        if (this.owners.has(spec.name)) continue;
        this.owners.set(spec.name, host);
        specs.push(spec);
      }
    }
    return specs;
  }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.owners.size) await this.list();
    const host = this.owners.get(name);
    if (!host) throw new Error(`Unknown tool: ${name}`);
    return host.call(name, input);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.hosts.map(host => host.close?.()));
  }
}
