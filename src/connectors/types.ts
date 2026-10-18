import type { Clock, FieldHint, SideEffects, Verb } from "../core/types.js";
import type { SecretStore } from "../secrets/store.js";

export type AuthSpec =
  | { type: "none" }
  | { type: "api-key"; secretKey: string; label: string }
  | { type: "local-path"; setting: string }
  | {
      type: "oauth2-pkce";
      authorizeUrl: string;
      tokenUrl: string;
      scopes: string[];
      extraParams?: Record<string, string>;
    };

export interface SettingField {
  key: string;
  label: string;
  type: "text" | "path" | "paths" | "select" | "secret";
  options?: string[];
  placeholder?: string;
}

export interface ConnectorContext {
  settings: Record<string, unknown>;
  secrets: SecretStore;
  fetch: typeof fetch;
  clock: Clock;
  /** IANA zone of the user, for parsing and showing times. */
  timeZone: string;
  locale: string;
}

export type ActionInput = Record<string, unknown>;

export interface ConnectorAction {
  /** Short name; the tool name is `<connector id>.<name>`. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effects: SideEffects;
  verb?: Verb;
  fields?: Record<string, FieldHint>;
  /** One line for the approval preview, built from the input. Never from the model. */
  summarize(input: ActionInput, ctx: ConnectorContext): string;
  run(input: ActionInput, ctx: ConnectorContext): Promise<string>;
}

export interface Connector {
  id: string;
  name: string;
  description: string;
  /** Icon id. Shells map it to their own symbols. */
  icon: string;
  auth: AuthSpec;
  actions: ConnectorAction[];
  settings?: SettingField[];
  /** "skeleton" connectors have complete metadata but need the user's own OAuth client. */
  status: "ready" | "skeleton";
}

export const str = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
export const strList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(String)
    : typeof value === "string"
      ? value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
export const clip = (s: string, max = 60) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
