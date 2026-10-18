import type { SideEffects } from "../core/types.js";
import type { ComposioTool } from "./client.js";

const READ_FIRST = new Set([
  "LIST",
  "GET",
  "FETCH",
  "SEARCH",
  "FIND",
  "READ",
  "QUERY",
  "LOOKUP",
  "COUNT",
  "CHECK",
  "VIEW",
  "RETRIEVE",
  "LOOK",
  "EVENTS",
]);
const WRITE_WORDS = new Set([
  "CREATE",
  "UPDATE",
  "PATCH",
  "SEND",
  "ADD",
  "MOVE",
  "INSERT",
  "SET",
  "MODIFY",
  "EDIT",
  "REPLY",
  "FORWARD",
  "POST",
  "PUBLISH",
  "INVITE",
  "SHARE",
  "DELETE",
  "REMOVE",
  "TRASH",
  "CLEAR",
  "PURGE",
  "CANCEL",
  "ARCHIVE",
  "MARK",
  "LABEL",
  "UPLOAD",
  "WRITE",
  "RUN",
  "EXECUTE",
  "ACCEPT",
  "DECLINE",
  "BATCH",
  "WATCH",
  "STOP",
  "SYNC",
  "IMPORT",
  "QUICK",
  "DRAFT",
]);
const DESTROY = new Set(["DELETE", "REMOVE", "TRASH", "CLEAR", "PURGE", "CANCEL", "ARCHIVE"]);
const SEND = new Set(["SEND", "REPLY", "FORWARD", "POST", "PUBLISH", "INVITE", "SHARE"]);

/**
 * Side effects for a Composio tool, worked out from its name. Only a name that starts with a read word and
 * contains no write word is treated as read-only, so an unfamiliar tool is shown to the user first.
 */
export function classifyEffects(tool: Pick<ComposioTool, "slug" | "tags">, toolkit: string): SideEffects {
  const prefix = toolkit.toUpperCase();
  const rest = tool.slug.toUpperCase().startsWith(`${prefix}_`) ? tool.slug.slice(prefix.length + 1) : tool.slug;
  const words = rest.toUpperCase().split("_").filter(Boolean);
  const destructive = words.some((w) => DESTROY.has(w)) || tool.tags.includes("destructiveHint");
  const sends = words.some((w) => SEND.has(w));
  const readOnly =
    !destructive &&
    !sends &&
    words.length > 0 &&
    words.some((w, i) => i < 2 && READ_FIRST.has(w)) &&
    !words.some((w) => WRITE_WORDS.has(w)) &&
    !tool.tags.includes("destructiveHint");
  if (readOnly) return { readOnly: true };
  return { modifies: true, ...(sends ? { sends: true } : {}), ...(destructive ? { destructive: true } : {}) };
}

const KEEP = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "description",
  "format",
  "minimum",
  "maximum",
]);

/** Trims a tool's JSON Schema to the parts every model API accepts. */
export function cleanSchema(schema: unknown, depth = 0): Record<string, unknown> {
  const input =
    schema && typeof schema === "object" && !Array.isArray(schema) ? (schema as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!KEEP.has(key)) continue;
    if (key === "properties" && value && typeof value === "object" && depth < 4) {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cleanSchema(v, depth + 1)]),
      );
    } else if (key === "items" && depth < 4) out.items = cleanSchema(value, depth + 1);
    else if (key === "description") out.description = String(value).slice(0, 240);
    else if (key === "required") out.required = Array.isArray(value) ? value.map(String) : [];
    else if (key !== "properties" && key !== "items") out[key] = value;
  }
  if (depth === 0) {
    out.type = "object";
    out.properties ??= {};
    if (Array.isArray(out.required)) {
      const props = out.properties as Record<string, unknown>;
      out.required = (out.required as string[]).filter((r) => r in props);
    }
  }
  return out;
}
