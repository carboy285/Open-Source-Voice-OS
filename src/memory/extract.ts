import { z } from "zod";
import type { LlmProvider } from "../core/types.js";
import { looksSensitive, type MemoryKind, type NewMemoryFact } from "./store.js";

export type MemoryCommand =
  { kind: "remember"; text: string } | { kind: "forget"; query: string } | { kind: "recall"; query?: string };

const KINDS = ["person", "project", "preference", "decision", "other"] as const;

const factSchema = z.object({
  text: z.string().trim().min(3).max(300),
  kind: z.enum(KINDS).default("other"),
  supersedes: z.string().trim().max(300).optional(),
});

const resultSchema = z.object({
  facts: z.array(factSchema).max(4),
});

const EXTRACT_SYSTEM = `You extract durable facts from one exchange between a user and their computer assistant.

Return JSON only, in this exact shape: {"facts":[{"text":"...","kind":"person|project|preference|decision|other","supersedes":"..."}]}

Include only facts the user would expect the assistant to remember later:
- names, relationships and roles
- stable preferences (tone, format, tools, routines)
- ongoing projects and what they are
- decisions and standing instructions

Do not include:
- one-off requests, questions, task results or anything the assistant said about itself
- temporary states, moods or plans for the next hour
- secrets, passwords, keys, tokens, financial details or health details
- anything the user did not actually state

Write each fact as one short third-person sentence under 200 characters. Use "supersedes" only when the new fact replaces an older one. If nothing qualifies, return {"facts":[]}.`;

/** "remember that …", "note that …", "keep in mind: …". Deliberately narrow, so "remember to call Ana" stays an agent request. */
const REMEMBER =
  /^(?:please\s+)?(?:remember|note|keep in mind|don'?t forget|make a note)(?:\s+(?:that|this))?\s*[:-]\s*(.+)$|^(?:please\s+)?(?:remember|note|keep in mind|don'?t forget)\s+(?:that|this)\s+(.+)$/i;

const FORGET =
  /^(?:please\s+)?(?:forget|remove from memory|delete from memory)\s+(?:that|about|the fact that)?\s*(.+?)[.!?]*$/i;

const RECALL_ALL =
  /^(?:what do you (?:remember|know)|what have you (?:remembered|learned)|list (?:your )?memory|show (?:me )?your memory)[?.!]*$/i;
const RECALL_ABOUT =
  /^(?:what do you (?:remember|know) about|what have you (?:remembered|learned) about|tell me what you remember about|do you remember)\s+(.+?)[?.!]*$/i;

/**
 * Handles memory commands without involving the model, so "remember this" and "what do you remember?" work offline
 * and cannot be answered with an invented memory.
 */
export function parseMemoryCommand(request: string): MemoryCommand | undefined {
  const text = request.trim();
  if (!text) return undefined;

  const remember = REMEMBER.exec(text);
  if (remember) {
    const fact = (remember[1] ?? remember[2] ?? "").trim().replace(/[.!?。！？]+$/u, "");
    if (fact.length >= 3 && !/^to\s/i.test(fact) && !looksSensitive(fact)) return { kind: "remember", text: fact };
  }

  const forget = FORGET.exec(text);
  if (forget) {
    const query = forget[1]!.trim();
    if (query.length >= 2 && !/^(it|that|this)$/i.test(query)) return { kind: "forget", query };
  }

  if (RECALL_ALL.test(text)) return { kind: "recall" };
  const about = RECALL_ABOUT.exec(text);
  if (about) return { kind: "recall", query: about[1]!.trim() };
  return undefined;
}

/** Turns one model reply into facts, dropping anything unsafe or malformed. */
export async function extractFacts(
  llm: LlmProvider,
  request: string,
  reply: string,
  signal?: AbortSignal,
): Promise<NewMemoryFact[]> {
  if (!request.trim() || !reply.trim()) return [];
  const response = await llm.complete({
    system: EXTRACT_SYSTEM,
    messages: [
      {
        role: "user",
        text: `User: ${request.slice(0, 4000)}\n\nAssistant: ${reply.slice(0, 2000)}\n\nReturn JSON only.`,
      },
    ],
    maxTokens: 500,
    signal,
  });
  const parsed = parseJson(response.text);
  if (!parsed) return [];
  const result = resultSchema.safeParse(parsed);
  if (!result.success) return [];
  const seen = new Set<string>();
  return result.data.facts
    .filter((fact) => !looksSensitive(fact.text))
    .filter((fact) => {
      const key = fact.text
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/[.!?]+$/, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((fact) => ({
      text: fact.text.replace(/\s+/g, " ").trim(),
      kind: fact.kind as MemoryKind,
      ...(fact.supersedes ? { supersedes: fact.supersedes } : {}),
    }));
}

/** Models sometimes wrap JSON in prose or fences. Keep the first object or array. */
export function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    if (start < 0) return undefined;
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (end <= start) return undefined;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}
