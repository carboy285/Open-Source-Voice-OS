import type { Readable, Writable } from "node:stream";
import { MurmurCore, type CapturedContext, type CoreOptions, type ShellBridge } from "../core/app.js";
import type { Pcm16Audio } from "../core/types.js";
import type { ApprovalResponse, ApprovalUi, FinalDecision } from "../gate/gate.js";
import type { Preview } from "../gate/preview.js";
import { catalog, resolveLocale } from "../i18n/index.js";
import type { SecretStore } from "../secrets/store.js";
import { JsonRpcPeer, RpcError, RpcErrors } from "./peer.js";

export const PROTOCOL_VERSION = 1;

/** Approval previews over RPC: `approval.request` out, `approval.respond` back. */
export class RpcApprovalUi implements ApprovalUi {
  private readonly waiting = new Map<string, (response: ApprovalResponse) => void>();

  constructor(private readonly peer: JsonRpcPeer) {}

  request(preview: Preview, signal: AbortSignal): Promise<ApprovalResponse> {
    return new Promise((resolve) => {
      const done = (response: ApprovalResponse) => {
        this.waiting.delete(preview.callId);
        resolve(response);
      };
      this.waiting.set(preview.callId, done);
      signal.addEventListener("abort", () => done({ decision: "cancel" }), { once: true });
      this.peer.notify("approval.request", { preview: preview as unknown as Record<string, unknown> });
    });
  }

  dismiss(callId: string, outcome: FinalDecision): void {
    this.peer.notify("approval.dismiss", { callId, outcome });
  }

  respond(callId: string, response: ApprovalResponse): boolean {
    const waiter = this.waiting.get(callId);
    if (!waiter) return false;
    waiter(response);
    return true;
  }
}

/** Keychain access through the shell. */
export class RpcSecretStore implements SecretStore {
  constructor(private readonly peer: JsonRpcPeer) {}
  async get(key: string): Promise<string | undefined> {
    const result = await this.peer.request<{ value?: string | null }>("secret.get", { key });
    return result?.value ?? undefined;
  }
  async set(key: string, value: string): Promise<void> {
    await this.peer.request("secret.set", { key, value });
  }
  async delete(key: string): Promise<void> {
    await this.peer.request("secret.delete", { key });
  }
}

export function rpcBridge(peer: JsonRpcPeer): ShellBridge & { approvals: RpcApprovalUi } {
  return {
    insertText: (text) => peer.request("text.insert", { text }, 10_000),
    captureContext: () => peer.request<CapturedContext>("context.capture", {}, 3_000),
    secrets: new RpcSecretStore(peer),
    approvals: new RpcApprovalUi(peer),
    openUrl: async (url) => void (await peer.request("url.open", { url }, 10_000)),
    // The Mac app answers apple.call with Mail, Calendar and Reminders. Other shells do not.
    ...(process.platform === "darwin"
      ? {
          native: (service: string, action: string, args: Record<string, unknown>) =>
            peer.request("apple.call", { service, action, args }, 60_000),
        }
      : {}),
    emit: (event) => {
      const { type, ...payload } = event;
      peer.notify(type, payload);
    },
  };
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string") throw new RpcError(RpcErrors.invalidParams, `${name} must be a string`);
  return v;
};

function decodeAudio(params: Record<string, unknown>): Pcm16Audio | undefined {
  if (typeof params.audio !== "string") return undefined;
  const pcm = new Uint8Array(Buffer.from(params.audio, "base64"));
  return { pcm, sampleRate: typeof params.sampleRate === "number" ? params.sampleRate : 16_000 };
}

/** Registers every shell → core method on the peer. */
export function registerMethods(peer: JsonRpcPeer, core: MurmurCore, approvals: RpcApprovalUi): void {
  peer
    .handle("core.hello", async () => ({
      protocol: PROTOCOL_VERSION,
      version: "0.1.0",
      ...(await core.status()),
    }))
    .handle("status", () => core.status())
    .handle("i18n.strings", (p) => {
      const locale = resolveLocale(typeof p.locale === "string" ? p.locale : core.settings.get("ui.locale"));
      return { locale, strings: catalog(locale) };
    })

    .handle("dictation.start", () => {
      core.beginDictation();
      return { ok: true };
    })
    .handle("dictation.stop", (p) =>
      core.finishDictation({
        audio: decodeAudio(p),
        transcript: typeof p.transcript === "string" ? p.transcript : undefined,
      }),
    )
    .handle("dictation.retry", () => core.finishDictation({}))
    .handle("dictation.cancel", () => {
      core.cancelDictation();
      return { ok: true };
    })
    .handle(
      "dictation.correct",
      (p) => core.observeCorrection(str(p.inserted, "inserted"), str(p.corrected, "corrected")) ?? null,
    )
    .handle("edit.run", (p) =>
      core.runEdit({
        audio: decodeAudio(p),
        transcript: typeof p.transcript === "string" ? p.transcript : undefined,
        context: p.context && typeof p.context === "object" ? (p.context as CapturedContext) : undefined,
      }),
    )
    .handle("conversation.reset", () => {
      core.conversation.reset();
      return { ok: true };
    })
    .handle("conversation.status", () => ({ turns: core.conversation.length }))

    .handle("agent.run", (p) =>
      core.startTask({
        audio: decodeAudio(p),
        transcript: typeof p.transcript === "string" ? p.transcript : undefined,
        context: p.context && typeof p.context === "object" ? (p.context as CapturedContext) : undefined,
      }),
    )
    .handle("approval.respond", (p) => {
      const decision = p.decision;
      if (decision !== "approve" && decision !== "edit" && decision !== "cancel") {
        throw new RpcError(RpcErrors.invalidParams, "decision must be approve, edit or cancel");
      }
      const input = p.input && typeof p.input === "object" ? (p.input as Record<string, unknown>) : undefined;
      const ok = approvals.respond(str(p.callId, "callId"), { decision, input });
      if (!ok) throw new RpcError(RpcErrors.app, "No pending approval with that callId");
      return { ok };
    })
    .handle("task.cancel", (p) => ({ ok: core.runner.cancel(str(p.taskId, "taskId")) }))
    .handle("task.list", (p) => ({
      tasks: core.runner.list({
        limit: typeof p.limit === "number" ? p.limit : 50,
        query: typeof p.query === "string" ? p.query : undefined,
      }),
    }))
    .handle("task.runAgain", (p) => {
      const started = core.runner.runAgain(str(p.taskId, "taskId"));
      if (!started) throw new RpcError(RpcErrors.app, "This task's request was not saved, so it can't run again.");
      return { taskId: started.taskId };
    })

    .handle("settings.get", (p) =>
      typeof p.key === "string" ? { value: core.settings.get(p.key) } : { values: core.settings.all() },
    )
    .handle("settings.set", (p) => {
      const key = str(p.key, "key");
      const before = core.settings.get(key);
      core.settings.set(key, p.value);
      const offerDelete = key === "history.saveTranscripts" && before === true && p.value === false;
      return { ok: true, offerDelete };
    })
    .handle("chatgpt.login.start", () => core.chatgptLogin())
    .handle("chatgpt.login.cancel", () => {
      core.chatgpt.cancel();
      return { ok: true };
    })
    .handle("chatgpt.status", () => core.chatgptStatus())
    .handle("chatgpt.logout", async () => {
      await core.chatgptLogout();
      return { ok: true };
    })
    .handle("models.list", () => core.modelState())
    .handle("models.download", (p) => {
      core.downloadModel(str(p.id, "id"));
      return { started: true };
    })
    .handle("models.cancel", (p) => {
      core.models.cancel(str(p.id, "id"));
      return { ok: true };
    })
    .handle("models.use", (p) => {
      core.useModel(str(p.id, "id"));
      return core.modelState();
    })
    .handle("models.remove", (p) => {
      core.removeModel(str(p.id, "id"));
      return core.modelState();
    })
    .handle("history.list", (p) => ({ items: core.history.list(typeof p.limit === "number" ? p.limit : 20) }))
    .handle("history.clearTranscripts", () => {
      core.history.clearTranscripts();
      return { ok: true };
    })

    .handle("dictionary.list", () => ({ entries: core.dictionary.list() }))
    .handle("dictionary.add", (p) => ({
      entry: core.dictionary.add({
        written: str(p.written, "written"),
        spoken: Array.isArray(p.spoken) ? p.spoken.map(String) : [],
        kind: typeof p.kind === "string" ? (p.kind as never) : undefined,
        caseSensitive: typeof p.caseSensitive === "boolean" ? p.caseSensitive : undefined,
      }),
    }))
    .handle("dictionary.update", (p) => ({ entry: core.dictionary.update(Number(p.id), (p.patch ?? {}) as never) }))
    .handle("dictionary.remove", (p) => {
      core.dictionary.remove(Number(p.id));
      return { ok: true };
    })

    .handle("connectors.list", () => ({ connectors: core.registry.catalog(), mcp: core.mcp.status() }))
    .handle("connectors.enable", (p) => {
      core.registry.enable(str(p.id, "id"));
      return { ok: true };
    })
    .handle("connectors.disable", (p) => {
      core.registry.disable(str(p.id, "id"));
      return { ok: true };
    })
    .handle("connectors.configure", (p) => {
      const all = core.settings.get("connectors.settings");
      all[str(p.id, "id")] = (p.settings ?? {}) as Record<string, unknown>;
      core.settings.set("connectors.settings", all);
      return { ok: true };
    })
    .handle("connectors.authorize", async (p) => {
      await core.authorizeConnector(str(p.id, "id"), async (url) => {
        await peer.request("url.open", { url });
      });
      return { ok: true };
    })
    .handle("composio.status", async () => ({
      hasKey: await core.composio.hasKey(),
      userId: core.composio.userId(),
    }))
    .handle("composio.setKey", async (p) => {
      await core.composio.setKey(str(p.key, "key"));
      return { ok: true };
    })
    .handle("composio.removeKey", async () => {
      await core.composio.removeKey();
      return { ok: true };
    })
    .handle("composio.apps", async (p) => ({
      apps: await core.composio.apps(typeof p.query === "string" ? p.query : undefined),
    }))
    .handle("composio.connect", (p) => {
      // The sign-in waits for the browser, so this answers at once and the result arrives as a composio.connect event.
      void core.composio.connect(str(p.app, "app")).catch(() => {});
      return { started: true };
    })
    .handle("composio.disconnect", async (p) => {
      await core.composio.disconnect(str(p.app, "app"));
      return { ok: true };
    })
    .handle("composio.configure", (p) => {
      core.composio.configure(str(p.app, "app"), {
        ...(typeof p.enabled === "boolean" ? { enabled: p.enabled } : {}),
        ...(typeof p.readOnly === "boolean" ? { readOnly: p.readOnly } : {}),
      });
      return { ok: true };
    })
    .handle("mcp.reload", async () => {
      await core.reloadMcp();
      return { servers: core.mcp.status() };
    })

    .handle("reminders.list", () => ({ reminders: core.reminders.list("scheduled") }))
    .handle("reminders.snooze", (p) => ({ reminder: core.scheduler.snooze(Number(p.id)) ?? null }))
    .handle("reminders.done", (p) => {
      core.scheduler.done(Number(p.id));
      return { ok: true };
    })

    .handle("data.deleteAll", async () => {
      await core.deleteAll();
      return { ok: true };
    });
}

export interface DaemonOptions extends Omit<CoreOptions, "bridge"> {
  input?: Readable;
  output?: Writable;
}

/** `murmur daemon`: serves the RPC on stdio until the shell closes stdin. */
export async function runDaemon(options: DaemonOptions = {}): Promise<{ core: MurmurCore; peer: JsonRpcPeer }> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const peer = new JsonRpcPeer(input, output, (error) =>
    process.stderr.write(`murmur: ${error.stack ?? error.message}\n`),
  );
  const bridge = rpcBridge(peer);
  const core = new MurmurCore({ ...options, bridge });
  registerMethods(peer, core, bridge.approvals);
  input.on("end", () => void core.close());
  await core.start();
  peer.notify("core.ready", { protocol: PROTOCOL_VERSION });
  return { core, peer };
}
