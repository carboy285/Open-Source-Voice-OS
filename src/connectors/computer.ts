import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";
import type { NativeCall } from "./apple.js";
import { clip, objectSchema, str, type Connector, type ConnectorAction } from "./types.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const list = (v: unknown): Obj[] => (Array.isArray(obj(v).items) ? (obj(v).items as unknown[]).map(obj) : []);

/** Runs a program with arguments and no shell, so nothing the model wrote is ever read as a command line. */
export type RunProgram = (file: string, args: string[]) => Promise<string>;

const runProgram: RunProgram = (file, args) =>
  new Promise((done, fail) => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 2_000_000 }, (error, stdout, stderr) => {
      if (error) fail(new Error(stderr.trim().split("\n")[0] || error.message));
      else done(stdout);
    });
  });

/** Files that run code when opened. Murmur does not open these for the agent. */
const RUNNABLE = new Set([
  ".command",
  ".tool",
  ".terminal",
  ".workflow",
  ".scpt",
  ".scptd",
  ".action",
  ".pkg",
  ".mpkg",
  ".exe",
  ".msi",
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  ".scr",
  ".jar",
  ".lnk",
  ".sh",
  ".py",
  ".pl",
  ".rb",
  ".webloc",
  ".inetloc",
  ".dmg",
  ".iso",
]);
const APP_FOLDERS = [
  "/Applications/",
  "/System/Applications/",
  "/System/Applications/Utilities/",
  "/Applications/Utilities/",
];

export type Target = { kind: "url"; url: string } | { kind: "path"; path: string };

/** A web link or a file or folder on this computer, checked. Throws a sentence the agent can pass on. */
export function checkTarget(raw: string, home = homedir(), exists: (p: string) => boolean = existsSync): Target {
  const text = raw.trim();
  if (!text) throw new Error("Say what to open.");
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new Error("That isn't a link I can open.");
    }
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
      throw new Error("Only web and email links can be opened.");
    }
    return { kind: "url", url: url.href };
  }
  const expanded = text.replace(/^~(?=$|[\\/])/, home);
  if (!isAbsolute(expanded)) throw new Error("Give the full path, like /Users/you/Documents/report.pdf.");
  const path = resolve(expanded);
  if (!exists(path)) throw new Error(`There is nothing at ${path}.`);
  const extension = extname(path).toLowerCase();
  if (RUNNABLE.has(extension)) {
    throw new Error(`Murmur doesn't open ${extension} files for the agent, because opening one can run it.`);
  }
  if (
    extension === ".app" &&
    !APP_FOLDERS.some((folder) => path.startsWith(folder)) &&
    !path.startsWith(`${home}/Applications/`)
  ) {
    throw new Error("Apps are opened by name, from the Applications folder.");
  }
  return { kind: "path", path };
}

/** What Murmur remembers about each item it showed the model, so a click can be described by what it is. */
interface Seen {
  app: string;
  role: string;
  label: string;
}

const ROLE_NAMES: Record<string, string> = {
  AXButton: "button",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio button",
  AXPopUpButton: "pop-up menu",
  AXMenuButton: "menu button",
  AXLink: "link",
  AXMenuItem: "menu item",
  AXTextField: "text field",
  AXTextArea: "text area",
  AXSearchField: "search field",
  AXStaticText: "text",
  AXComboBox: "combo box",
  AXTab: "tab",
  AXSlider: "slider",
  AXDisclosureTriangle: "disclosure arrow",
  AXSegmentedControl: "segmented control",
};
const roleName = (role: string) => ROLE_NAMES[role] ?? role.replace(/^AX/, "").toLowerCase();

export interface ComputerOptions {
  /** The Mac app, for anything that needs the Accessibility API. Absent on other systems. */
  native?: NativeCall;
  run?: RunProgram;
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (path: string) => boolean;
}

/**
 * Lets the agent open files, links and apps, and (on a Mac) look at an app's window and press buttons, type and
 * choose menu items. Everything that changes anything shows a preview first. What each preview says about an
 * item comes from the screen reading Murmur did itself, never from the model's own description of it.
 */
export function computerConnector(options: ComputerOptions = {}): Connector {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runProgram;
  const home = options.home ?? homedir();
  const exists = options.exists ?? existsSync;
  const mac = platform === "darwin";
  const native = options.native;
  const seen = new Map<string, Seen>();

  const describe = (id: string): Seen | undefined => seen.get(id);
  const needsMac = () => {
    if (!mac) throw new Error("This works on a Mac only for now.");
  };
  const needsNative = (): NativeCall => {
    if (!native) throw new Error("This needs the Murmur app for Mac.");
    return native;
  };

  const actions: ConnectorAction[] = [
    {
      name: "open",
      description:
        "Open a file or folder in its usual app, show it in Finder, or open a web or email link in the browser. Give the full path, like /Users/name/Documents/report.pdf. Use find_files to look for a file first.",
      inputSchema: objectSchema(
        {
          target: {
            type: "string",
            minLength: 1,
            description: "Full path of a file or folder, or an http, https or mailto link.",
          },
          show_in_finder: { type: "boolean", description: "Reveal it in Finder instead of opening it." },
        },
        ["target"],
      ),
      effects: { modifies: true },
      verb: "Run",
      fields: { target: { label: "Open", type: "path" } },
      summarize(input) {
        const target = str(input.target);
        return `${input.show_in_finder === true ? "Show in Finder" : "Open"} ${clip(target, 100)}`;
      },
      async run(input) {
        const target = checkTarget(str(input.target), home, exists);
        const where = target.kind === "url" ? target.url : target.path;
        if (mac) {
          await run(
            "open",
            target.kind === "path" && input.show_in_finder === true ? ["-R", "--", where] : ["--", where],
          );
        } else if (platform === "win32") {
          await run(
            "explorer.exe",
            target.kind === "path" && input.show_in_finder === true ? [`/select,${where}`] : [where],
          );
        } else {
          await run("xdg-open", [where]);
        }
        return target.kind === "url"
          ? `Opened ${where}.`
          : `${input.show_in_finder === true ? "Showed" : "Opened"} ${where}.`;
      },
    },
    {
      name: "find_files",
      description:
        "Find files and folders in the user's home folder by (part of) their name, using Spotlight. Returns full paths, newest matches first when Spotlight knows the dates.",
      inputSchema: objectSchema({ name: { type: "string", minLength: 1, maxLength: 100 } }, ["name"]),
      effects: { readOnly: true },
      summarize: (input) => `Look for files named "${clip(str(input.name), 50)}"`,
      async run(input) {
        needsMac();
        const name = str(input.name).trim();
        if (!name) throw new Error("Say part of the file's name.");
        const out = await run("mdfind", ["-onlyin", home, "-name", name]);
        const paths = out
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.includes("/Library/") && !/\/\.[^/]/.test(line))
          .slice(0, 20);
        return paths.length ? paths.join("\n") : "No files with that name.";
      },
    },
    {
      name: "open_app",
      description: "Open an app by name, like Safari, Spotify or Notes. If it is already open it comes to the front.",
      inputSchema: objectSchema({ app: { type: "string", minLength: 1, maxLength: 80 } }, ["app"]),
      effects: { modifies: true },
      verb: "Run",
      fields: { app: { label: "App" } },
      summarize: (input) => `Open the app ${clip(str(input.app), 60)}`,
      async run(input) {
        needsMac();
        const app = str(input.app).trim();
        if (!app || app.startsWith("-") || /[/\\]/.test(app)) throw new Error("Give the app's name, like Safari.");
        await run("open", ["-a", app]);
        return `Opened ${app}.`;
      },
    },
    {
      name: "apps",
      description: "List the apps that are open now, and which one is in front.",
      inputSchema: objectSchema({}),
      effects: { readOnly: true },
      summarize: () => "List open apps",
      async run() {
        const apps = list(await needsNative()("computer", "apps", {}));
        if (!apps.length) return "No apps are open.";
        return apps.map((a) => `${str(a.name)}${a.active === true ? " (in front)" : ""}`).join("\n");
      },
    },
    {
      name: "quit_app",
      description:
        "Quit an app politely, the way its Quit menu does. An app with unsaved work will ask the user first.",
      inputSchema: objectSchema({ app: { type: "string", minLength: 1, maxLength: 80 } }, ["app"]),
      effects: { modifies: true },
      verb: "Run",
      fields: { app: { label: "App" } },
      summarize: (input) => `Quit ${clip(str(input.app), 60)}`,
      async run(input) {
        const done = obj(await needsNative()("computer", "quit", { app: str(input.app) }));
        return `Quit ${str(done.name, str(input.app))}.`;
      },
    },
    {
      name: "read_screen",
      description:
        "Look at an app's front window and list what can be pressed or typed into: each item has an id like e12, a kind and a name. Use the ids with click and type. Look again after anything changes; ids only work for the most recent look. Defaults to the app in front.",
      inputSchema: objectSchema({ app: { type: "string", description: "App name. Default: the app in front." } }),
      effects: { readOnly: true },
      summarize: (input) => (str(input.app) ? `Look at ${clip(str(input.app), 40)}` : "Look at the front window"),
      async run(input) {
        const result = obj(await needsNative()("computer", "ui_read", { app: str(input.app) }));
        const app = str(result.app);
        seen.clear();
        const lines: string[] = [`${app}${str(result.window) ? `: ${str(result.window)}` : ""}`];
        const menus = Array.isArray(result.menus) ? (result.menus as unknown[]).map(String) : [];
        if (menus.length) lines.push(`Menus: ${menus.join(", ")}`);
        for (const item of list(result)) {
          const id = str(item.id);
          const role = str(item.role);
          const label = str(item.label);
          if (!id) continue;
          if (role !== "AXStaticText") seen.set(id, { app, role, label });
          const extras = [
            item.secure === true ? "password field, hidden" : "",
            item.enabled === false ? "disabled" : "",
            typeof item.value === "string" && item.value ? `contains "${clip(item.value, 60)}"` : "",
          ].filter(Boolean);
          lines.push(
            `${id} ${roleName(role)}${label ? ` "${label}"` : ""}${extras.length ? ` (${extras.join(", ")})` : ""}`,
          );
        }
        if (result.truncated === true) lines.push("(There is more in this window than is listed.)");
        return lines.join("\n");
      },
    },
    {
      name: "click",
      description:
        "Press a button, tick a box, follow a link or put the cursor in a field, by the id read_screen gave. Read the screen first.",
      inputSchema: objectSchema({ id: { type: "string", minLength: 1 } }, ["id"]),
      effects: { modifies: true },
      verb: "Run",
      fields: { id: { label: "Item" } },
      summarize(input) {
        const item = describe(str(input.id));
        return item
          ? `Click the ${roleName(item.role)} "${clip(item.label || "unnamed", 60)}" in ${item.app}`
          : "Click an item that wasn't on the last look at the screen";
      },
      async run(input) {
        const id = str(input.id);
        const item = describe(id);
        if (!item) throw new Error("I haven't looked at the screen yet, or it has changed. Use read_screen first.");
        await needsNative()("computer", "ui_click", { id, role: item.role, label: item.label });
        return `Clicked "${item.label || roleName(item.role)}" in ${item.app}.`;
      },
    },
    {
      name: "type",
      description:
        "Type text into an app, at the cursor or into the field with the given id (from read_screen). Never into password fields.",
      inputSchema: objectSchema(
        {
          app: { type: "string", minLength: 1, description: "The app to type into." },
          text: { type: "string", minLength: 1, maxLength: 2000 },
          id: { type: "string", description: "Field to click into first (from read_screen)." },
        },
        ["app", "text"],
      ),
      effects: { modifies: true },
      verb: "Run",
      fields: { app: { label: "App" }, text: { label: "Text", type: "longtext" } },
      summarize(input) {
        const item = input.id ? describe(str(input.id)) : undefined;
        const into = item
          ? ` into the ${roleName(item.role)}${item.label ? ` "${clip(item.label, 40)}"` : ""} in ${item.app}`
          : ` into ${clip(str(input.app), 40)}`;
        return `Type "${clip(str(input.text).replace(/\s+/g, " "), 80)}"${into}`;
      },
      async run(input) {
        const item = input.id ? describe(str(input.id)) : undefined;
        if (input.id && !item)
          throw new Error("That field is from an older look at the screen. Use read_screen again.");
        await needsNative()("computer", "ui_type", {
          app: str(input.app),
          text: str(input.text),
          ...(item ? { id: str(input.id), role: item.role, label: item.label } : {}),
        });
        return `Typed ${str(input.text).length} characters into ${str(input.app)}.`;
      },
    },
    {
      name: "press_keys",
      description:
        'Press a key or shortcut in an app, like "return", "tab", "escape", "cmd+s" or "cmd+shift+4". Prefer choose_menu when the action is in a menu.',
      inputSchema: objectSchema(
        { app: { type: "string", minLength: 1 }, keys: { type: "string", minLength: 1, maxLength: 40 } },
        ["app", "keys"],
      ),
      effects: { modifies: true },
      verb: "Run",
      fields: { app: { label: "App" }, keys: { label: "Keys" } },
      summarize: (input) => `Press ${clip(str(input.keys), 30)} in ${clip(str(input.app), 40)}`,
      async run(input) {
        await needsNative()("computer", "ui_key", { app: str(input.app), keys: str(input.keys) });
        return `Pressed ${str(input.keys)} in ${str(input.app)}.`;
      },
    },
    {
      name: "choose_menu",
      description: 'Choose an item from an app\'s menu bar, with the path as a list, like ["File", "New Window"].',
      inputSchema: objectSchema(
        {
          app: { type: "string", minLength: 1 },
          path: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
        },
        ["app", "path"],
      ),
      effects: { modifies: true },
      verb: "Run",
      fields: { app: { label: "App" }, path: { label: "Menu path" } },
      summarize: (input) =>
        `Choose ${Array.isArray(input.path) ? (input.path as unknown[]).map(String).join(" ▸ ") : "a menu item"} in ${clip(str(input.app), 40)}`,
      async run(input) {
        const path = Array.isArray(input.path) ? (input.path as unknown[]).map(String) : [];
        if (!path.length) throw new Error("Give the menu path, like File, New Window.");
        await needsNative()("computer", "menu", { app: str(input.app), path });
        return `Chose ${path.join(" ▸ ")} in ${str(input.app)}.`;
      },
    },
  ];

  // The window actions need the Mac app's Accessibility access. Elsewhere only opening and finding are offered.
  const needsApp = new Set(["apps", "quit_app", "read_screen", "click", "type", "press_keys", "choose_menu"]);
  const macOnly = new Set(["find_files", "open_app"]);
  return {
    id: "computer",
    name: "Computer",
    description:
      "Open files, links and apps, and use apps for the user: look at a window, press buttons, type and choose menus. Always shows a preview before it acts.",
    icon: "computer",
    auth: { type: "none" },
    status: "ready",
    actions: actions.filter((a) => ((native && mac) || !needsApp.has(a.name)) && (mac || !macOnly.has(a.name))),
  };
}
