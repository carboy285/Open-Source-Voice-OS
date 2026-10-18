#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createLlm, createStt } from "../config.js";
import { Vocabulary } from "../core/vocabulary.js";
import type { ConfirmHandler, ToolHost } from "../core/types.js";
import { loadMcpConfig, McpToolHost } from "../mcp/host.js";
import { runAgent } from "../modes/agent.js";
import { dictate } from "../modes/dictation.js";
import { editSelection } from "../modes/edit.js";
import { codexAuth } from "../providers/codex.js";
import { StdoutInjector } from "../providers/injectors.js";

const USAGE = `voiceos <command>

  login                         Sign in with your ChatGPT plan (runs "codex login")
  status                        Show Codex sign-in status
  dictate  --text T | --audio F | --stdin [--app NAME] [--polish] [--spoken-punctuation] [--vocabulary FILE]
  edit     --instruction I --selection S
  agent    --text T | --audio F | --stdin [--mcp FILE] [--yes]
  help, --help, -h               Show this help

Model: VOICEOS_LLM=codex (default) or anthropic. Audio needs WHISPER_MODEL (whisper.cpp).
MCP servers: --mcp FILE or ./voiceos.mcp.json, e.g. REA (see voiceos.mcp.example.json).`;

async function transcript(values: { text?: string; audio?: string; stdin?: boolean }): Promise<string> {
  const sources = Number(values.text !== undefined) + Number(values.audio !== undefined) + Number(values.stdin === true);
  if (sources !== 1) throw new Error("Provide exactly one of --text, --audio, or --stdin.");
  let text: string;
  if (values.text !== undefined) text = values.text;
  else if (values.audio !== undefined) text = await createStt().transcribe(values.audio);
  else {
    if (process.stdin.isTTY) throw new Error("--stdin requires piped text. Use --text for interactive input.");
    process.stdin.setEncoding("utf8");
    text = "";
    for await (const chunk of process.stdin) text += chunk;
  }
  if (!text.trim()) throw new Error("The transcript is empty.");
  return text;
}

const askConfirm: ConfirmHandler = async ({ tool, input }) => {
  // Piped stdin is the transcript, not a place to solicit approval. Fail closed unless --yes was explicit.
  if (!process.stdin.isTTY) {
    console.error(`Cannot ask permission for "${tool}" without a terminal; action denied. Use --yes only to approve all tools.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`Allow ${tool} ${JSON.stringify(input)}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
};

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(USAGE);
    return 0;
  }
  if (!["login", "status", "dictate", "edit", "agent"].includes(command)) {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      text: { type: "string" },
      audio: { type: "string" },
      stdin: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      vocabulary: { type: "string" },
      app: { type: "string" },
      polish: { type: "boolean" },
      "spoken-punctuation": { type: "boolean" },
      instruction: { type: "string" },
      selection: { type: "string" },
      mcp: { type: "string" },
      yes: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  switch (command) {
    case "login":
      return codexAuth(process.env["VOICEOS_CODEX_BIN"]).login();
    case "status": {
      const { loggedIn, detail } = await codexAuth(process.env["VOICEOS_CODEX_BIN"]).status();
      console.log(detail || (loggedIn ? "Logged in" : "Not logged in"));
      return loggedIn ? 0 : 1;
    }
    case "dictate": {
      const injector = new StdoutInjector();
      const vocabulary = values.vocabulary
        ? Vocabulary.parse(JSON.parse(await readFile(values.vocabulary, "utf8")))
        : undefined;
      await dictate(
        await transcript(values),
        injector,
        { appName: values.app },
        { spokenPunctuation: values["spoken-punctuation"], vocabulary, polish: values.polish ? createLlm() : undefined },
      );
      return 0;
    }
    case "edit": {
      if (!values.instruction || values.selection === undefined) throw new Error("Provide --instruction and --selection.");
      await editSelection(values.instruction, new StdoutInjector(values.selection), createLlm());
      return 0;
    }
    case "agent": {
      const request = await transcript(values);
      const mcpPath = values.mcp ?? (existsSync("voiceos.mcp.json") ? "voiceos.mcp.json" : undefined);
      const tools: ToolHost = mcpPath
        ? await McpToolHost.connect(await loadMcpConfig(mcpPath))
        : { list: async () => [], call: async () => "" };
      try {
        const confirm: ConfirmHandler = values.yes ? async () => true : askConfirm;
        const outcome = await runAgent(request, createLlm(), tools, confirm);
        console.log(outcome.reply);
      } finally {
        await tools.close?.();
      }
      return 0;
    }
    default:
      console.error(USAGE);
      return command ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
