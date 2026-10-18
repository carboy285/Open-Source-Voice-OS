import { readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { clip, objectSchema, str, strList, type Connector, type ConnectorContext } from "./types.js";

const SKIP = new Set(["node_modules", ".git", "Library", "AppData", "$Recycle.Bin"]);

function roots(ctx: ConnectorContext): string[] {
  const list = strList(ctx.settings.roots);
  return (list.length ? list : [homedir()]).map((r) => resolve(r));
}

const expand = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

/** Resolves a path and refuses anything outside the allowed folders. */
export function insideRoots(path: string, allowed: string[]): string {
  const full = resolve(expand(path));
  for (const root of allowed) {
    const rel = relative(root, full);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return full;
  }
  throw new Error(`${path} is outside the folders Murmur may use. Add its folder in Settings › Connectors › Files.`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const validName = (name: string) => name.length > 0 && !/[\\/]/.test(name) && name !== "." && name !== "..";

export function filesConnector(): Connector {
  return {
    id: "files",
    name: "Files",
    description: "Find files by name, read their details, and rename or move them.",
    icon: "folder",
    auth: { type: "none" },
    status: "ready",
    settings: [{ key: "roots", label: "Folders Murmur may use", type: "paths" }],
    actions: [
      {
        name: "search",
        description: "Find files and folders whose name contains the query.",
        inputSchema: objectSchema(
          { query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 100 } },
          ["query"],
        ),
        effects: { readOnly: true },
        summarize: (i) => `Find files named like "${clip(str(i.query))}"`,
        async run(input, ctx) {
          const query = str(input.query).toLowerCase();
          const limit = Number(input.limit ?? 25);
          const found: string[] = [];
          const queue: Array<[string, number]> = roots(ctx).map((r) => [r, 0]);
          while (queue.length && found.length < limit) {
            const [dir, depth] = queue.shift()!;
            let entries;
            try {
              entries = await readdir(dir, { withFileTypes: true });
            } catch {
              continue;
            }
            for (const entry of entries) {
              if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
              const full = join(dir, entry.name);
              if (entry.name.toLowerCase().includes(query)) found.push(entry.isDirectory() ? `${full}${sep}` : full);
              if (found.length >= limit) break;
              if (entry.isDirectory() && depth < 6) queue.push([full, depth + 1]);
            }
          }
          return found.length ? found.join("\n") : "No matching files.";
        },
      },
      {
        name: "metadata",
        description: "Read a file's size, dates and type.",
        inputSchema: objectSchema({ path: { type: "string" } }, ["path"]),
        effects: { readOnly: true },
        summarize: (i) => `Details of ${clip(str(i.path), 80)}`,
        async run(input, ctx) {
          const path = insideRoots(str(input.path), roots(ctx));
          const s = await stat(path);
          return JSON.stringify({
            path,
            type: s.isDirectory() ? "folder" : "file",
            bytes: s.size,
            modified: s.mtime.toISOString(),
            created: s.birthtime.toISOString(),
          });
        },
      },
      {
        name: "rename",
        description: "Rename a file or folder in place.",
        inputSchema: objectSchema({ path: { type: "string" }, newName: { type: "string", minLength: 1 } }, [
          "path",
          "newName",
        ]),
        effects: { modifies: true },
        verb: "Rename",
        fields: { path: { label: "File", type: "path" }, newName: { label: "New name", type: "text" } },
        summarize: (i) => `Rename ${basename(str(i.path))} to ${str(i.newName)}`,
        async run(input, ctx) {
          const from = insideRoots(str(input.path), roots(ctx));
          const name = str(input.newName);
          if (!validName(name)) throw new Error("The new name cannot contain slashes.");
          const to = join(dirname(from), name);
          if (await exists(to)) throw new Error(`${name} already exists there.`);
          await rename(from, to);
          return `Renamed to ${to}`;
        },
      },
      {
        name: "move",
        description: "Move a file or folder into another folder.",
        inputSchema: objectSchema({ path: { type: "string" }, destination: { type: "string" } }, [
          "path",
          "destination",
        ]),
        effects: { modifies: true },
        verb: "Move",
        fields: { path: { label: "File", type: "path" }, destination: { label: "Move to folder", type: "path" } },
        summarize: (i) => `Move ${basename(str(i.path))} to ${str(i.destination)}`,
        async run(input, ctx) {
          const allowed = roots(ctx);
          const from = insideRoots(str(input.path), allowed);
          const folder = insideRoots(str(input.destination), allowed);
          if (!(await stat(folder)).isDirectory()) throw new Error(`${folder} is not a folder.`);
          const to = join(folder, basename(from));
          if (await exists(to)) throw new Error(`${basename(from)} already exists in ${folder}.`);
          await rename(from, to);
          return `Moved to ${to}`;
        },
      },
    ],
  };
}
