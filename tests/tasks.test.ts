import { describe, expect, it } from "vitest";
import { Database } from "../src/storage/db.js";
import { TaskRepo } from "../src/storage/repos.js";
import { TaskRunner, type TaskUpdate } from "../src/tasks/runner.js";
import { ScriptedApprovalUi } from "./fakes/approval.js";
import { ScriptedLlm, toolCall } from "./fakes/llm.js";
import { RecordingToolHost, searchFiles, sendEmail } from "./fakes/tools.js";

describe("TaskRunner", () => {
  it("reports status, waits for approval and persists history", async () => {
    const db = new Database();
    const updates: TaskUpdate[] = [];
    const llm = new ScriptedLlm([
      { text: "", toolCalls: [toolCall("a", "gmail.send", { to: ["a@example.com"], subject: "Hi", body: "Yo" })] },
      { text: "Sent.", toolCalls: [] },
    ]);
    const runner = new TaskRunner({
      llm: () => llm,
      tools: new RecordingToolHost([sendEmail]),
      approvals: new ScriptedApprovalUi([{ decision: "approve" }]),
      store: new TaskRepo(db),
      onUpdate: (u) => updates.push(u),
    });
    const { taskId, done } = runner.start("email a hi");
    const record = await done;
    expect(record).toMatchObject({ status: "done", reply: "Sent.", transcript: null });
    expect(updates.map((u) => u.status)).toContain("waiting_approval");
    expect(runner.list()[0]).toMatchObject({
      id: taskId,
      status: "done",
      steps: [{ tool: "gmail.send", approval: "approved" }],
    });
    db.close();
  });

  it("cancels before the next tool call", async () => {
    const host = new RecordingToolHost([searchFiles]);
    const llm = new ScriptedLlm([
      {
        text: "",
        toolCalls: [toolCall("a", "files.search", { query: "1" }), toolCall("b", "files.search", { query: "2" })],
      },
      { text: "never", toolCalls: [] },
    ]);
    let id = "";
    const runner: TaskRunner = new TaskRunner({
      llm: () => llm,
      tools: host,
      approvals: new ScriptedApprovalUi([]),
      onUpdate: (u) => {
        if (u.steps.length === 1) runner.cancel(id);
      },
    });
    const started = runner.start("search twice");
    id = started.taskId;
    const record = await started.done;
    expect(record.status).toBe("cancelled");
    expect(host.calls).toHaveLength(1);
  });

  it("marks a task long after 3 tool steps and notifies at the end", async () => {
    const calls = [1, 2, 3, 4].map((n) => ({
      text: "",
      toolCalls: [toolCall(`c${n}`, "files.search", { query: `${n}` })],
    }));
    const notes: string[] = [];
    const updates: TaskUpdate[] = [];
    const runner = new TaskRunner({
      llm: () => new ScriptedLlm([...calls, { text: "Found it.", toolCalls: [] }]),
      tools: new RecordingToolHost([searchFiles]),
      approvals: new ScriptedApprovalUi([]),
      onUpdate: (u) => updates.push(u),
      notify: (status, reply) => notes.push(`${status}:${reply}`),
    });
    await runner.start("find it").done;
    expect(updates.at(-1)?.long).toBe(true);
    expect(notes).toEqual(["done:Found it."]);
  });

  it("fails clearly with no model and saves transcripts only when opted in", async () => {
    const runner = new TaskRunner({
      llm: () => undefined,
      tools: new RecordingToolHost([]),
      approvals: new ScriptedApprovalUi([]),
      saveTranscripts: () => true,
    });
    const record = await runner.start("hello").done;
    expect(record).toMatchObject({ status: "failed", transcript: "hello" });
    expect(runner.runAgain(record.id)).toBeDefined();
  });
});
