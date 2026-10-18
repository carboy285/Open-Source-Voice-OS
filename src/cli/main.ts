#!/usr/bin/env node
import { databasePath, mcpConfigPath } from "../core/paths.js";
import { VERSION } from "../core/version.js";

// node:sqlite prints an experimental warning on import; keep stderr clean for the shells.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning instanceof Error ? warning.message : warning).includes("SQLite")) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const HELP = `Murmur ${VERSION}: voice dictation and a voice agent for your computer.

Usage:
  murmur daemon                      Run the core for a native shell (JSON-RPC on stdio)
  murmur clean "<text>" [--app <id>] Clean up a transcript and print the change report
  murmur agent "<request>"           Run an agent task in this terminal, with approvals
  murmur add mcp <name> -- <command> [args...]
  murmur add mcp <name> --url <https-url> [--header KEY=VALUE]...
  murmur list mcp
  murmur remove mcp <name>
  murmur models [list | download <id> | use <id> | remove <id>]
  murmur version`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "daemon": {
      const { runDaemon } = await import("../rpc/daemon.js");
      await runDaemon();
      return -1;
    }
    case "models": {
      const { runModelsCli } = await import("../models/cli.js");
      const { ModelManager } = await import("../models/manager.js");
      const { Database } = await import("../storage/db.js");
      const { SettingsRepo } = await import("../storage/repos.js");
      const { modelsDir } = await import("../core/paths.js");
      const db = new Database(databasePath());
      const settings = new SettingsRepo(db);
      try {
        return await runModelsCli(rest, {
          manager: new ModelManager(modelsDir()),
          out: (line) => process.stdout.write(`${line}\n`),
          getActive: () => settings.get("stt.parakeetModel"),
          setActive: (id) => {
            settings.set("stt.parakeetModel", id);
            if (id) settings.set("stt.engine", "parakeet");
          },
        });
      } finally {
        db.close();
      }
    }
    case "add":
    case "list":
    case "remove": {
      if (rest[0] !== "mcp") {
        process.stderr.write(`${HELP}\n`);
        return 2;
      }
      const { runMcpCli } = await import("../mcp/cli.js");
      const { OsKeychainStore } = await import("../secrets/os-keychain.js");
      return runMcpCli(command, rest.slice(1), {
        configPath: mcpConfigPath(),
        secrets: new OsKeychainStore(),
        out: (line) => process.stdout.write(`${line}\n`),
      });
    }
    case "clean":
      return clean(rest);
    case "agent":
      return agent(rest.join(" "));
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${HELP}\n`);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}\n`);
      return 2;
  }
}

async function clean(args: string[]): Promise<number> {
  const appIndex = args.indexOf("--app");
  const appId = appIndex >= 0 ? args[appIndex + 1] : undefined;
  const text = (appIndex >= 0 ? args.filter((_, i) => i !== appIndex && i !== appIndex + 1) : args).join(" ");
  if (!text) {
    process.stderr.write('Give some text: murmur clean "um so the meeting is at noon"\n');
    return 2;
  }
  const { processDictation } = await import("../modes/dictation.js");
  const { summarizeChanges } = await import("../dictation/changes.js");
  const { t } = await import("../i18n/index.js");
  const result = await processDictation(text, { appId });
  process.stdout.write(`${result.text}\n`);
  const summary = Object.entries(summarizeChanges(result.changes)).map(([category, count]) =>
    t(`report.${category}`, { count: count ?? 0, word: "" }),
  );
  process.stderr.write(`[${result.category}] ${summary.join(" · ") || t("report.empty")}\n`);
  return 0;
}

async function agent(request: string): Promise<number> {
  if (!request.trim()) {
    process.stderr.write('Say what to do: murmur agent "remind me to call Ana at 3"\n');
    return 2;
  }
  const { MurmurCore } = await import("../core/app.js");
  const { OsKeychainStore } = await import("../secrets/os-keychain.js");
  const { TerminalApprovalUi } = await import("./terminal-approval.js");
  const { AnthropicLlm } = await import("../providers/anthropic.js");
  const envKey = process.env.ANTHROPIC_API_KEY;
  const core = new MurmurCore({
    llm: envKey ? new AnthropicLlm({ apiKey: envKey, model: process.env.MURMUR_MODEL }) : undefined,
    bridge: {
      insertText: async (text) => {
        process.stdout.write(`${text}\n`);
        return { ok: true, method: "stdout" };
      },
      captureContext: async () => ({}),
      secrets: new OsKeychainStore(),
      approvals: new TerminalApprovalUi(),
      emit: (event) => {
        if (event.type === "task.update" && event.currentStep) process.stderr.write(`… ${event.currentStep}\n`);
      },
    },
  });
  await core.start();
  try {
    if (!(await core.llm())) {
      process.stderr.write(`${core.t("agent.no_llm")} Or set ANTHROPIC_API_KEY.\n`);
      return 1;
    }
    const { taskId } = await core.startTask({ transcript: request });
    const done = await new Promise<{ reply: string; status: string }>((resolve) => {
      const poll = setInterval(() => {
        const task = core.runner.get(taskId);
        if (task && task.finishedAt !== null) {
          clearInterval(poll);
          resolve(task);
        }
      }, 100);
    });
    process.stdout.write(`${done.reply}\n`);
    return done.status === "done" ? 0 : 1;
  } finally {
    await core.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
