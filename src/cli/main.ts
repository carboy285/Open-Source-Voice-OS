#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createLlm, createStt } from "../config.js";
import type { ConfirmHandler, ToolHost } from "../core/types.js";
import { loadMcpConfig, McpToolHost } from "../mcp/host.js";
import { runAgent } from "../modes/agent.js";
import { parseSnippetFlags, resolveUtterance } from "../modes/commands.js";
import { dictate } from "../modes/dictation.js";
import { editSelection } from "../modes/edit.js";
import { codexAuth } from "../providers/codex.js";
import { StdoutInjector } from "../providers/injectors.js";

const USAGE = `voiceos <command>

  login                         Sign in with your ChatGPT plan (runs "codex login")
  status                        Show Codex sign-in status
  dictate  --text T | --audio F [--app NAME] [--polish] [--spoken-punctuation] [--snippet "phrase=text"]...
  edit     --instruction I --selection S
  agent    --text T | --audio F [--mcp FILE] [--yes]

Model: VOICEOS_LLM=codex (default) or anthropic. Audio needs WHISPER_MODEL (whisper.cpp).
Snippets: repeat --snippet "my address=1 Infinite Loop" to expand a spoken phrase.
MCP servers: --mcp FILE or ./voiceos.mcp.json, e.g. REA (see voiceos.mcp.example.json).`;

async function transcript(values: { text?: string; audio?: string }): Promise<string> {
  if (values.text) return values.text;
  if (values.audio) return createStt().transcribe(values.audio);
  throw new Error("Provide --text or --audio.");
}

const askConfirm: ConfirmHandler = async ({ tool, input }) => {
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
  const { values } = parseArgs({
    args: rest,
    options: {
      text: { type: "string" },
      audio: { type: "string" },
      app: { type: "string" },
      polish: { type: "boolean" },
      "spoken-punctuation": { type: "boolean" },
      snippet: { type: "string", multiple: true },
      instruction: { type: "string" },
      selection: { type: "string" },
      mcp: { type: "string" },
      yes: { type: "boolean" },
    },
  });

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
      const spoken = await transcript(values);
      const utterance = resolveUtterance(spoken, {
        snippets: parseSnippetFlags(values.snippet),
        // The CLI prints to stdout; it cannot press Cmd+Z in another app.
        commands: false,
      });
      if (utterance.kind === "snippet") {
        await injector.insert(utterance.text);
        return 0;
      }
      if (utterance.kind === "command") {
        throw new Error(`"${utterance.command}" is a voice command; it only works in the macOS app.`);
      }
      await dictate(
        utterance.text,
        injector,
        { appName: values.app },
        { spokenPunctuation: values["spoken-punctuation"], polish: values.polish ? createLlm() : undefined },
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
