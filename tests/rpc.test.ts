import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { LlmProvider } from "../src/core/types.js";
import { runDaemon } from "../src/rpc/daemon.js";
import { JsonRpcPeer, RpcErrors } from "../src/rpc/peer.js";
import { fakeShell } from "./fakes/shell.js";
import { ScriptedLlm, toolCall } from "./fakes/llm.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function start(llm?: LlmProvider) {
  const s = fakeShell();
  const dir = mkdtempSync(join(tmpdir(), "murmur-rpc-"));
  const { core } = await runDaemon({
    input: s.coreInput,
    output: s.coreOutput,
    databasePath: ":memory:",
    mcpConfigPath: join(dir, "mcp.json"),
    stt: { transcribe: async () => ({ text: "um send the the report to ana" }) },
    llm,
  });
  closers.push(() => core.close());
  return { ...s, core };
}

describe("JsonRpcPeer", () => {
  it("answers requests both ways and reports unknown methods and parse errors", async () => {
    const a2b = new PassThrough();
    const b2a = new PassThrough();
    const a = new JsonRpcPeer(b2a, a2b);
    const b = new JsonRpcPeer(a2b, b2a);
    b.handle("add", (p) => Number(p.x) + Number(p.y));
    a.handle("ping", () => "pong");
    expect(await a.request("add", { x: 2, y: 3 })).toBe(5);
    expect(await b.request("ping")).toBe("pong");
    await expect(a.request("nope")).rejects.toMatchObject({ code: RpcErrors.methodNotFound });

    const replies: string[] = [];
    b2a.on("data", (d: Buffer) => replies.push(d.toString()));
    a2b.write("{not json\n");
    await new Promise((r) => setTimeout(r, 10));
    expect(JSON.parse(replies.join("").trim())).toMatchObject({ error: { code: RpcErrors.parse } });
  });
});

describe("core ↔ shell protocol", () => {
  it("handshakes and serves the UI strings", async () => {
    const { shell, waitFor } = await start();
    await waitFor("core.ready");
    expect(await shell.request("core.hello", { shell: "test" })).toMatchObject({ protocol: 1, llm: false, stt: true });
    const ja = await shell.request<{ locale: string; strings: Record<string, string> }>("i18n.strings", {
      locale: "ja",
    });
    expect(ja.locale).toBe("ja");
    expect(ja.strings["menu.quit"]).toBe("Murmur を終了");
  });

  it("runs dictation: capture on start, insert on stop, report the changes", async () => {
    const { shell, inserted, waitFor, events } = await start();
    await shell.request("dictation.start");
    // One second of a 440 Hz tone: silent audio would be stopped before it reaches the STT.
    const tone = Buffer.alloc(32000);
    for (let i = 0; i < 16000; i++)
      tone.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2);
    const audio = tone.toString("base64");
    const result = await shell.request<{ text: string; summary: Array<{ category: string; label: string }> }>(
      "dictation.stop",
      {
        audio,
      },
    );
    expect(result.text).toBe("Send the report to ana.");
    expect(inserted).toEqual(["Send the report to ana."]);
    const report = await waitFor("dictation.result");
    expect(report.summary).toContainEqual({ category: "filler_removed", count: 2, label: "Removed 2 fillers" });
    expect(events.filter((e) => e.method === "state").map((e) => e.params.state)).toEqual([
      "listening",
      "transcribing",
      "cleaning",
      "inserting",
      "done",
    ]);
  });

  it("gates agent actions over RPC: Edit, then Send runs the edited input", async () => {
    const llm = new ScriptedLlm([
      { text: "", toolCalls: [toolCall("c1", "reminders.create", { text: "call Ana", when: "in 10 minutes" })] },
      { text: "Reminder set.", toolCalls: [] },
    ]);
    const { shell, waitFor, core } = await start(llm);
    let shown = 0;
    shell.on("approval.request", (p) => {
      const preview = p.preview as { callId: string; raw: Record<string, unknown>; state: string };
      shown++;
      if (shown === 1) {
        void shell.request("approval.respond", {
          callId: preview.callId,
          decision: "edit",
          input: { ...preview.raw, text: "call Ben" },
        });
      } else {
        expect(preview.state).toBe("edited");
        void shell.request("approval.respond", { callId: preview.callId, decision: "approve" });
      }
    });
    const { taskId } = await shell.request<{ taskId: string }>("agent.run", {
      transcript: "remind me to call Ana in 10 minutes",
    });
    await waitFor("task.update", (p) => p.taskId === taskId && p.status === "done");
    expect(core.reminders.list("scheduled").map((r) => r.text)).toEqual(["call Ben"]);
    const list = await shell.request<{ tasks: Array<{ steps: Array<{ approval: string }> }> }>("task.list");
    expect(list.tasks[0]!.steps[0]!.approval).toBe("edited");
  });

  it("runs nothing when the shell cancels the preview", async () => {
    const llm = new ScriptedLlm([
      { text: "", toolCalls: [toolCall("c1", "reminders.create", { text: "call Ana", when: "in 10 minutes" })] },
      { text: "Okay.", toolCalls: [] },
    ]);
    const { shell, waitFor, core } = await start(llm);
    shell.on("approval.request", (p) => {
      void shell.request("approval.respond", { callId: (p.preview as { callId: string }).callId, decision: "cancel" });
    });
    const { taskId } = await shell.request<{ taskId: string }>("agent.run", { transcript: "remind me" });
    await waitFor("task.update", (p) => p.taskId === taskId && p.status === "done");
    await waitFor("approval.dismiss", (p) => p.outcome === "cancelled");
    expect(core.reminders.list()).toEqual([]);
  });

  it("remembers a typed conversation between requests, and starts over on reset", async () => {
    const llm = new ScriptedLlm([
      { text: "Your dentist is at 3pm.", toolCalls: [] },
      { text: "Okay, 4pm it is.", toolCalls: [] },
      { text: "I don't know what you mean.", toolCalls: [] },
    ]);
    const { shell, waitFor } = await start(llm);
    const ask = async (transcript: string) => {
      const { taskId } = await shell.request<{ taskId: string }>("agent.run", { transcript });
      await waitFor("task.update", (p) => p.taskId === taskId && p.status === "done");
    };
    await ask("what time is my dentist");
    await ask("move it to 4");
    const second = llm.requests[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(await shell.request("conversation.status")).toEqual({ turns: 2 });

    await shell.request("conversation.reset");
    expect(await shell.request("conversation.status")).toEqual({ turns: 0 });
    await ask("and the one after that?");
    expect(llm.requests[2]!.messages).toHaveLength(1);
  });

  it("edits typed instructions against the selection captured before the box opened", async () => {
    const llm = new ScriptedLlm([{ text: "Shorter text.", toolCalls: [] }]);
    const { shell, inserted } = await start(llm);
    await shell.request("edit.run", {
      transcript: "make it shorter",
      context: { appName: "Notes", selection: "A very long text that goes on." },
    });
    expect(inserted).toEqual(["Shorter text."]);
    const sent = llm.requests[0]!.messages.map((m) => (m.role === "user" ? m.text : "")).join("\n");
    expect(sent).toContain("A very long text that goes on.");
  });

  it("rejects bad approval responses and offers to delete transcripts when turned off", async () => {
    const { shell } = await start();
    await expect(shell.request("approval.respond", { callId: "x", decision: "yes" })).rejects.toMatchObject({
      code: RpcErrors.invalidParams,
    });
    await shell.request("settings.set", { key: "history.saveTranscripts", value: true });
    expect(await shell.request("settings.set", { key: "history.saveTranscripts", value: false })).toEqual({
      ok: true,
      offerDelete: true,
    });
  });

  it("deletes all data, including keychain entries", async () => {
    const { shell, secrets, core } = await start();
    secrets.set("llm/apiKey", "sk-test");
    await shell.request("dictionary.add", { written: "Murmur" });
    await shell.request("data.deleteAll");
    expect(secrets.size).toBe(0);
    expect(core.dictionary.list()).toEqual([]);
  });
});
