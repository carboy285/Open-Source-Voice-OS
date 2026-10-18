import type { AgentHub } from "../agents/hub.js";
import { clip, objectSchema, str, type Connector } from "./types.js";

const KINDS = ["codex", "claude", "opencode"];

/**
 * Lets the voice agent start and watch coding agents on this computer. Starting, messaging and stopping always show
 * a preview first; listing and status only read.
 */
export function agentsConnector(hub: AgentHub): Connector {
  const line = (s: ReturnType<AgentHub["list"]>[number]) =>
    `${s.id}: ${s.label} · ${s.status.replace("_", " ")} · ${s.cwd} · ${clip(s.text, 120)}`;
  return {
    id: "agents",
    name: "Coding agents",
    description: "Start Codex, Claude Code or OpenCode on a project, check on them, and answer them when they ask.",
    icon: "agent",
    auth: { type: "none" },
    status: "ready",
    actions: [
      {
        name: "list",
        description:
          "List the coding agents Murmur started, with what each is doing, and the project folders used before. Use it to find an id or a folder.",
        inputSchema: objectSchema({}),
        effects: { readOnly: true },
        summarize: () => "List coding agents",
        async run() {
          const sessions = hub.list();
          const folders = hub.recent();
          return [
            sessions.length ? sessions.map(line).join("\n") : "No coding agents have been started.",
            folders.length ? `Recent folders: ${folders.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        },
      },
      {
        name: "status",
        description: "Say what one coding agent is doing right now.",
        inputSchema: objectSchema({ id: { type: "string" } }, ["id"]),
        effects: { readOnly: true },
        summarize: () => "Check a coding agent",
        async run(input) {
          const session = hub.get(str(input.id));
          if (!session) throw new Error(`There is no agent session ${str(input.id)}.`);
          return line(session);
        },
      },
      {
        name: "start",
        description:
          "Start a coding agent on a project. It runs on the user's computer and can change files there, so the user reviews this first. Give the full path of the project folder (see agents.list for recent ones) and a clear task. Never claim it finished: it works in the background and the user is told when it does.",
        inputSchema: objectSchema(
          {
            agent: { type: "string", enum: KINDS, description: "codex, claude (Claude Code) or opencode." },
            folder: { type: "string", description: "Full path of the project folder." },
            task: { type: "string", minLength: 1, description: "What the agent should do." },
          },
          ["agent", "folder", "task"],
        ),
        effects: { modifies: true },
        verb: "Run",
        fields: {
          agent: { label: "Agent" },
          folder: { label: "Project folder", type: "path" },
          task: { label: "Task", type: "longtext" },
        },
        summarize: (input) => `Start ${str(input.agent)} in ${str(input.folder)}: "${clip(str(input.task), 80)}"`,
        async run(input) {
          const session = await hub.start({ kind: str(input.agent), folder: str(input.folder), task: str(input.task) });
          if (session.status === "failed") throw new Error(session.error ?? `${session.label} didn't start.`);
          return `Started ${session.label} (id ${session.id}) in ${session.cwd}. It works in the background. Murmur will show a card when it needs the user.`;
        },
      },
      {
        name: "send",
        description: "Send a follow-up instruction to a running coding agent.",
        inputSchema: objectSchema({ id: { type: "string" }, message: { type: "string", minLength: 1 } }, [
          "id",
          "message",
        ]),
        effects: { modifies: true },
        verb: "Send",
        fields: { id: { label: "Agent session" }, message: { label: "Message", type: "longtext" } },
        summarize: (input) => `Tell agent ${str(input.id)}: "${clip(str(input.message), 80)}"`,
        async run(input) {
          await hub.send(str(input.id), str(input.message));
          return "Sent.";
        },
      },
      {
        name: "stop",
        description: "Stop a coding agent.",
        inputSchema: objectSchema({ id: { type: "string" } }, ["id"]),
        effects: { modifies: true },
        verb: "Run",
        summarize: (input) => `Stop coding agent ${str(input.id)}`,
        async run(input) {
          await hub.stop(str(input.id));
          return "Stopped.";
        },
      },
    ],
  };
}
