import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { insideRoots } from "./files.js";
import { clip, objectSchema, str, type Connector, type ConnectorContext } from "./types.js";

function vault(ctx: ConnectorContext): string {
  const path = str(ctx.settings.vaultPath);
  if (!path) throw new Error("Choose your Obsidian vault folder in Settings › Connectors › Obsidian.");
  return path;
}

/** Resolves a note inside the vault, adding .md when missing. */
function notePath(ctx: ConnectorContext, note: string): string {
  const root = vault(ctx);
  const withExt = note.toLowerCase().endsWith(".md") ? note : `${note}.md`;
  return insideRoots(join(root, withExt), [root]);
}

async function* markdownFiles(dir: string, depth = 0): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory() && depth < 10) yield* markdownFiles(full, depth + 1);
    else if (entry.name.endsWith(".md")) yield full;
  }
}

const safeTitle = (title: string) => title.replace(/[\\/:*?"<>|#^[\]]/g, " ").trim();

export function obsidianConnector(): Connector {
  return {
    id: "obsidian",
    name: "Obsidian",
    description: "Search, read and write notes in a local Obsidian vault.",
    icon: "note",
    auth: { type: "local-path", setting: "vaultPath" },
    status: "ready",
    settings: [{ key: "vaultPath", label: "Vault folder", type: "path" }],
    actions: [
      {
        name: "search_notes",
        description: "Find notes whose title or text contains the query.",
        inputSchema: objectSchema({ query: { type: "string", minLength: 1 } }, ["query"]),
        effects: { readOnly: true },
        summarize: (i) => `Search notes for "${clip(str(i.query))}"`,
        async run(input, ctx) {
          const root = vault(ctx);
          const q = str(input.query).toLowerCase();
          const hits: string[] = [];
          for await (const file of markdownFiles(root)) {
            const name = relative(root, file);
            const text = await readFile(file, "utf8").catch(() => "");
            const at = text.toLowerCase().indexOf(q);
            if (name.toLowerCase().includes(q) || at >= 0) {
              const snippet = at >= 0 ? text.slice(Math.max(0, at - 60), at + 100).replace(/\s+/g, " ") : "";
              hits.push(snippet ? `${name}: …${snippet}…` : name);
            }
            if (hits.length >= 20) break;
          }
          return hits.length ? hits.join("\n") : "No matching notes.";
        },
      },
      {
        name: "read_note",
        description: "Read a note by its path inside the vault.",
        inputSchema: objectSchema({ note: { type: "string" } }, ["note"]),
        effects: { readOnly: true },
        summarize: (i) => `Read ${str(i.note)}`,
        async run(input, ctx) {
          const text = await readFile(notePath(ctx, str(input.note)), "utf8");
          return text.length > 12000 ? `${text.slice(0, 12000)}…` : text;
        },
      },
      {
        name: "create_note",
        description: "Create a new note. Fails if a note with that title exists.",
        inputSchema: objectSchema(
          { title: { type: "string", minLength: 1 }, content: { type: "string" }, folder: { type: "string" } },
          ["title", "content"],
        ),
        effects: { modifies: true },
        verb: "Save",
        fields: { content: { label: "Note", type: "longtext" }, folder: { label: "Folder", type: "path" } },
        summarize: (i) => `New note "${clip(str(i.title))}"${str(i.folder) ? ` in ${str(i.folder)}` : ""}`,
        async run(input, ctx) {
          const path = notePath(ctx, join(str(input.folder), safeTitle(str(input.title))));
          if (
            await stat(path).then(
              () => true,
              () => false,
            )
          )
            throw new Error("A note with that title already exists.");
          await mkdir(join(path, ".."), { recursive: true });
          await writeFile(path, str(input.content), { flag: "wx" });
          return `Created ${relative(vault(ctx), path)}`;
        },
      },
      {
        name: "append",
        description: "Add text to the end of an existing note.",
        inputSchema: objectSchema({ note: { type: "string" }, content: { type: "string", minLength: 1 } }, [
          "note",
          "content",
        ]),
        effects: { modifies: true },
        verb: "Save",
        fields: { content: { label: "Text to add", type: "longtext" } },
        summarize: (i) => `Add to ${str(i.note)}: "${clip(str(i.content), 50)}"`,
        async run(input, ctx) {
          const path = notePath(ctx, str(input.note));
          await stat(path);
          const current = await readFile(path, "utf8");
          await appendFile(path, `${current.endsWith("\n") || !current ? "" : "\n"}${str(input.content)}\n`);
          return `Added to ${relative(vault(ctx), path)}`;
        },
      },
    ],
  };
}
