import type { ToolHost, ToolSpec } from "../core/types.js";
import { validate } from "../gate/schema.js";
import type { Connector, ConnectorContext } from "./types.js";

export interface RegistryState {
  isEnabled(id: string): boolean;
  setEnabled(id: string, enabled: boolean): void;
  settingsFor(id: string): Record<string, unknown>;
}

export class MemoryRegistryState implements RegistryState {
  constructor(
    private readonly enabled = new Set<string>(),
    private readonly settings: Record<string, Record<string, unknown>> = {},
  ) {}
  isEnabled(id: string): boolean {
    return this.enabled.has(id);
  }
  setEnabled(id: string, on: boolean): void {
    if (on) this.enabled.add(id);
    else this.enabled.delete(id);
  }
  settingsFor(id: string): Record<string, unknown> {
    return this.settings[id] ?? {};
  }
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  icon: string;
  auth: Connector["auth"]["type"];
  status: Connector["status"];
  enabled: boolean;
  actions: Array<{ name: string; readOnly: boolean }>;
  settings: Connector["settings"];
}

/** Holds the connectors. Only enabled ones expose tools to the agent. */
export class ConnectorRegistry implements ToolHost {
  private readonly connectors = new Map<string, Connector>();

  constructor(
    private readonly state: RegistryState,
    private readonly context: (connectorId: string) => ConnectorContext,
  ) {}

  register(...connectors: Connector[]): this {
    for (const c of connectors) this.connectors.set(c.id, c);
    return this;
  }

  enable(id: string): void {
    if (!this.connectors.has(id)) throw new Error(`Unknown connector: ${id}`);
    this.state.setEnabled(id, true);
  }

  disable(id: string): void {
    this.state.setEnabled(id, false);
  }

  catalog(): CatalogEntry[] {
    return [...this.connectors.values()].map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      icon: c.icon,
      auth: c.auth.type,
      status: c.status,
      enabled: this.state.isEnabled(c.id),
      actions: c.actions.map((a) => ({ name: a.name, readOnly: a.effects.readOnly === true })),
      settings: c.settings,
    }));
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  async list(): Promise<ToolSpec[]> {
    const specs: ToolSpec[] = [];
    for (const c of this.connectors.values()) {
      if (!this.state.isEnabled(c.id)) continue;
      for (const action of c.actions) {
        specs.push({
          name: `${c.id}.${action.name}`,
          description: `${c.name}: ${action.description}`,
          inputSchema: action.inputSchema,
          origin: "builtin",
          effects: action.effects,
          preview: {
            summarize: (input) => action.summarize(input, this.context(c.id)),
            verb: action.verb,
            fields: action.fields,
            icon: c.icon,
            displayName: `${c.name}`,
          },
        });
      }
    }
    return specs;
  }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    const dot = name.indexOf(".");
    const connector = this.connectors.get(name.slice(0, dot));
    const action = connector?.actions.find((a) => a.name === name.slice(dot + 1));
    if (!connector || !action) throw new Error(`Unknown tool: ${name}`);
    if (!this.state.isEnabled(connector.id)) throw new Error(`${connector.name} is turned off.`);
    const problems = validate(action.inputSchema, input);
    if (problems.length) throw new Error(`Invalid input: ${problems.join("; ")}`);
    return action.run(input, this.context(connector.id));
  }
}

/** Joins several tool hosts (connectors, MCP) into one. */
export class CompositeToolHost implements ToolHost {
  constructor(private readonly hosts: ToolHost[]) {}
  async list(): Promise<ToolSpec[]> {
    return (await Promise.all(this.hosts.map((h) => h.list()))).flat();
  }
  async call(name: string, input: Record<string, unknown>): Promise<string> {
    for (const host of this.hosts) {
      if ((await host.list()).some((s) => s.name === name)) return host.call(name, input);
    }
    throw new Error(`Unknown tool: ${name}`);
  }
  async close(): Promise<void> {
    await Promise.all(this.hosts.map((h) => h.close?.()));
  }
}
