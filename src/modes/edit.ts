import type { LlmProvider, TextInjector } from "../core/types.js";

const EDIT_SYSTEM = `You rewrite text according to a spoken instruction. You receive the selected text and the instruction. Apply only the requested change and keep everything else. Reply with the full rewritten text only: no quotes, no commentary.`;

/** Rewrites the current selection according to a spoken instruction. */
export async function editSelection(instruction: string, injector: TextInjector, llm: LlmProvider): Promise<string> {
  const selection = await injector.getSelection();
  if (!selection.trim()) throw new Error("Nothing is selected to edit.");
  const response = await llm.complete({
    system: EDIT_SYSTEM,
    messages: [{ role: "user", text: `Instruction: ${instruction}\n\nSelected text:\n${selection}` }],
    maxTokens: 2048,
  });
  const rewritten = response.text.trim();
  if (!rewritten) throw new Error("The model returned no text.");
  await injector.replaceSelection(rewritten);
  return rewritten;
}
