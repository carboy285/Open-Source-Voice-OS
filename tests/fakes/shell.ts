import { PassThrough } from "node:stream";
import { JsonRpcPeer } from "../../src/rpc/peer.js";

/** A test shell connected to the core over in-memory streams, speaking the real protocol. */
export function fakeShell() {
  const toCore = new PassThrough();
  const toShell = new PassThrough();
  const shell = new JsonRpcPeer(toShell, toCore);
  const inserted: string[] = [];
  const secrets = new Map<string, string>();
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const wire: string[] = [];
  toCore.on("data", (d: Buffer) => wire.push(...d.toString().split("\n").filter(Boolean)));
  shell
    .handle("text.preview", () => ({ approved: true }))
    .handle("text.insert", (p) => {
      inserted.push(String(p.text));
      return { ok: true, method: "accessibility" };
    })
    .handle("context.capture", () => ({ appId: "com.apple.mail", appName: "Mail", windowTitle: "New Message" }))
    .handle("secret.get", (p) => ({ value: secrets.get(String(p.key)) ?? null }))
    .handle("secret.set", (p) => {
      secrets.set(String(p.key), String(p.value));
      return { ok: true };
    })
    .handle("secret.delete", (p) => {
      secrets.delete(String(p.key));
      return { ok: true };
    });
  for (const method of [
    "state",
    "dictation.result",
    "task.update",
    "notify",
    "approval.request",
    "approval.dismiss",
    "reminder.fire",
    "conversation.update",
    "core.ready",
  ]) {
    shell.on(method, (params) => events.push({ method, params }));
  }
  const waitFor = async (
    method: string,
    predicate: (p: Record<string, unknown>) => boolean = () => true,
    ms = 2000,
  ) => {
    const start = Date.now();
    for (;;) {
      const hit = events.find((e) => e.method === method && predicate(e.params));
      if (hit) return hit.params;
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${method}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { shell, coreInput: toCore, coreOutput: toShell, inserted, secrets, events, wire, waitFor };
}
