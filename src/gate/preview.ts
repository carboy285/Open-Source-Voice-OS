import type { FieldType, ToolCall, ToolSpec, Verb } from "../core/types.js";
import { buildCard, type Card, type CardContext } from "./card.js";
import { classify, type Risk } from "./classify.js";
import type { JsonSchema } from "./schema.js";

export interface PreviewField {
  key: string;
  label: string;
  type: FieldType;
  value: unknown;
}

export interface Preview {
  callId: string;
  tool: string;
  displayName: string;
  icon: string;
  verb: Verb;
  /** One line from the connector's summarize(), never from the model. */
  summary: string;
  fields: PreviewField[];
  /** How the shell draws the preview: an event, an email, a reminder... See card.ts. */
  card?: Card;
  raw: Record<string, unknown>;
  risk: Risk;
  state: "pending" | "edited";
  /** "confirm" is the second step of a destructive approval. */
  stage: "review" | "confirm";
  errors?: string[];
  expiresAt: number;
}

const RECIPIENT_KEYS = /^(to|cc|bcc|recipients?|attendees|emails?|channel)$/i;
const PATH_KEYS = /(path|file|folder|directory|dir|destination|source)$/i;
const LONG_KEYS = /^(body|content|text|message|description|notes?|markdown)$/i;
const DATE_KEYS = /(at|time|date|start|end|due)$/i;

function fieldType(key: string, schema: JsonSchema | undefined): FieldType {
  if (schema?.format === "date-time" || schema?.format === "date") return "datetime";
  if (RECIPIENT_KEYS.test(key)) return "recipients";
  if (schema?.format === "email" || (schema?.type === "array" && (schema.items as JsonSchema)?.format === "email")) {
    return "recipients";
  }
  if (PATH_KEYS.test(key)) return "path";
  if (LONG_KEYS.test(key) || (typeof schema?.maxLength === "number" && schema.maxLength > 200)) return "longtext";
  if (
    DATE_KEYS.test(key) &&
    schema?.type === "string" &&
    /^(due_?at|starts?_?at|ends?_?at|when|date|time)$/i.test(key)
  ) {
    return "datetime";
  }
  return "text";
}

const humanize = (key: string) =>
  key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());

/** Editable fields in schema order, then any extra input keys. */
export function buildFields(spec: ToolSpec, input: Record<string, unknown>): PreviewField[] {
  const props = (spec.inputSchema.properties ?? {}) as Record<string, JsonSchema>;
  const keys = [...Object.keys(props), ...Object.keys(input).filter((k) => !(k in props))];
  return keys
    .filter(
      (key) => input[key] !== undefined || ((spec.inputSchema.required as string[] | undefined) ?? []).includes(key),
    )
    .map((key) => {
      const hint = spec.preview?.fields?.[key];
      const schema = props[key];
      return {
        key,
        label: hint?.label ?? (typeof schema?.title === "string" ? schema.title : humanize(key)),
        type: hint?.type ?? fieldType(key, schema),
        value: input[key] ?? "",
      };
    });
}

/** Summary written by Murmur for tools without a connector summarize() (MCP and unknown tools). */
export function genericSummary(displayName: string, input: Record<string, unknown>): string {
  const parts = Object.entries(input).map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return `${key}: ${text.length > 40 ? `${text.slice(0, 39)}…` : text}`;
  });
  const line = parts.length ? `${displayName} (${parts.join(", ")})` : displayName;
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

export function buildPreview(
  call: ToolCall,
  spec: ToolSpec,
  input: Record<string, unknown>,
  extra: {
    state: Preview["state"];
    stage: Preview["stage"];
    expiresAt: number;
    errors?: string[];
    card?: CardContext;
  },
): Preview {
  const { risk, verb } = classify(spec);
  const displayName = spec.preview?.displayName ?? spec.annotations?.title ?? spec.name;
  let summary: string;
  try {
    summary = spec.preview ? spec.preview.summarize(input) : genericSummary(displayName, input);
  } catch {
    summary = genericSummary(displayName, input);
  }
  const { card: cardContext, ...rest } = extra;
  let card: Card | undefined;
  try {
    card = buildCard(
      { name: spec.name, icon: spec.preview?.icon ?? (spec.origin === "mcp" ? "mcp" : "tool"), app: displayName },
      input,
      summary,
      cardContext ?? { now: Date.now(), timeZone: "UTC", locale: "en-US" },
    );
  } catch {
    // A card is only a nicer way to draw the preview; the fields below are always enough.
  }
  return {
    callId: call.id,
    tool: spec.name,
    displayName,
    icon: spec.preview?.icon ?? (spec.origin === "mcp" ? "mcp" : "tool"),
    verb,
    summary,
    fields: buildFields(spec, input),
    ...(card ? { card } : {}),
    raw: structuredClone(input),
    risk,
    ...rest,
  };
}

/** Converts edited field values back to the types the schema expects (e.g. "a, b" → ["a", "b"]). */
export function coerceInput(schema: JsonSchema, input: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const type = props[key]?.type;
    if (typeof value !== "string") out[key] = value;
    else if (type === "array")
      out[key] = value
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
    else if ((type === "number" || type === "integer") && value.trim() !== "" && !Number.isNaN(Number(value))) {
      out[key] = Number(value);
    } else if (type === "boolean" && (value === "true" || value === "false")) out[key] = value === "true";
    else if (value === "" && !((schema.required as string[] | undefined) ?? []).includes(key)) continue;
    else out[key] = value;
  }
  return out;
}
