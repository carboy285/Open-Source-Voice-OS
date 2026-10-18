import { clip, objectSchema, str, type Connector } from "./types.js";

export type InsertText = (text: string) => Promise<{ ok: boolean; method: string; reason?: string }>;

const FIELDS = { text: { label: "Text", type: "longtext" as const } };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lets the agent put text where the user is working: a reply under the cursor, or a rewrite of the selection.
 * Every call shows a preview first. Text goes through the same insertion as dictation.
 */
export function writingConnector(insert: InsertText, settleMs = 300): Connector {
  const run = async (input: Record<string, unknown>): Promise<string> => {
    const text = str(input.text);
    if (!text.trim()) throw new Error("There is no text to insert.");
    // After an approval the card gives focus back to the user's app; give it a moment.
    await wait(settleMs);
    const result = await insert(text);
    if (result.reason === "secure") throw new Error("That is a password field, so nothing was typed.");
    if (!result.ok)
      throw new Error("Couldn't place the text. It is on the clipboard: paste it with Command V (Ctrl V on Windows).");
    return `Inserted ${text.length} characters.`;
  };
  return {
    id: "write",
    name: "Write into the app",
    description: "Type text where you are working, such as a reply or a rewrite of the selected text.",
    icon: "note",
    auth: { type: "none" },
    status: "ready",
    actions: [
      {
        name: "insert",
        description:
          "Type text at the cursor in the app the user is working in, for example a drafted reply. Replaces the selected text if some is selected. The user reviews the text first.",
        inputSchema: objectSchema({ text: { type: "string", minLength: 1 } }, ["text"]),
        effects: { modifies: true },
        verb: "Save",
        fields: FIELDS,
        summarize: (input) => `Type "${clip(str(input.text), 70)}" into the app you are in`,
        run,
      },
    ],
  };
}
