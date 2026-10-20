import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MurmurCore } from "../src/core/app.js";
import { MODELS, RECOMMENDED_MODEL } from "../src/models/catalog.js";
import { ModelManager } from "../src/models/manager.js";
import { ParakeetCppStt } from "../src/providers/parakeet-cpp.js";
import { WhisperCppStt } from "../src/providers/whisper-cpp.js";
import { MemorySecretStore } from "../src/secrets/store.js";
import { ScriptedApprovalUi } from "./fakes/approval.js";

const content = Buffer.alloc(300_000, 7);
const sha = createHash("sha256").update(content).digest("hex");
let etag = sha;
let server: Server;
let base = "";

/** Mimics Hugging Face: /resolve/main/<file> redirects to the CDN and carries the SHA-256 in x-linked-etag. */
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/resolve/main/")) {
      const file = req.url.slice("/resolve/main/".length);
      res.writeHead(302, { location: `/cdn/${file}`, "x-linked-etag": `"${etag}"` }).end();
    } else if (req.url?.startsWith("/cdn/")) {
      res.writeHead(200, { "content-length": content.length }).end(content);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/resolve/main/`;
});
afterAll(() => server.close());

const newDir = () => mkdtempSync(join(tmpdir(), "murmur-models-"));

describe("ModelManager", () => {
  it("downloads into the models folder and verifies the checksum", async () => {
    etag = sha;
    const dir = newDir();
    const manager = new ModelManager(dir, fetch, base);
    const progress: number[] = [];
    const path = await manager.download(RECOMMENDED_MODEL.id, (p) => progress.push(p.received));
    expect(path).toBe(join(dir, RECOMMENDED_MODEL.file));
    expect(manager.isInstalled(RECOMMENDED_MODEL.id)).toBe(true);
    expect(progress.at(-1)).toBe(content.length);
    expect(manager.list().find((m) => m.id === RECOMMENDED_MODEL.id)?.bytes).toBe(content.length);
    expect(readdirSync(dir)).toEqual([RECOMMENDED_MODEL.file]);
  });

  it("discards a download that doesn't match the published checksum", async () => {
    etag = "0".repeat(64);
    const dir = newDir();
    const manager = new ModelManager(dir, fetch, base);
    await expect(manager.download(RECOMMENDED_MODEL.id)).rejects.toThrow(/didn't match/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses to download when no checksum is published", async () => {
    etag = "not-a-sha";
    const manager = new ModelManager(newDir(), fetch, base);
    await expect(manager.download(RECOMMENDED_MODEL.id)).rejects.toThrow(/checksum/);
  });

  it("offers NVIDIA Parakeet models with the balanced one recommended", () => {
    expect(MODELS.every((m) => m.engine === "parakeet" && m.file.startsWith("ggml-parakeet-tdt-0.6b-v3-"))).toBe(true);
    expect(RECOMMENDED_MODEL.id).toBe("parakeet-tdt-0.6b-v3-q8_0");
    expect(RECOMMENDED_MODEL.languages).toContain("en");
  });
});

describe("core speech engine", () => {
  function core(modelsDir: string) {
    return new MurmurCore({
      databasePath: ":memory:",
      mcpConfigPath: "/nonexistent/mcp.json",
      modelsDir,
      bridge: {
        insertText: async () => ({ ok: true, method: "test" }),
        captureContext: async () => ({}),
        secrets: new MemorySecretStore(),
        approvals: new ScriptedApprovalUi([]),
        emit: () => {},
      },
    });
  }

  it("uses Parakeet once a downloaded model is chosen, and falls back to whisper without one", async () => {
    const dir = newDir();
    const c = core(dir);
    expect(await c.stt()).toBeUndefined();
    c.settings.set("stt.model", "/models/ggml-base.bin");
    expect(await c.stt()).toBeInstanceOf(WhisperCppStt);

    expect(() => c.useModel(RECOMMENDED_MODEL.id)).toThrow(/Download/);
    writeFileSync(join(dir, RECOMMENDED_MODEL.file), "model");
    c.useModel(RECOMMENDED_MODEL.id);
    expect(await c.stt()).toBeInstanceOf(ParakeetCppStt);
    expect(c.modelState().active).toBe(RECOMMENDED_MODEL.id);

    c.settings.set("stt.engine", "whisper");
    expect(await c.stt()).toBeInstanceOf(WhisperCppStt);

    c.settings.set("stt.engine", "parakeet");
    c.removeModel(RECOMMENDED_MODEL.id);
    expect(existsSync(join(dir, RECOMMENDED_MODEL.file))).toBe(false);
    expect(c.settings.get("stt.parakeetModel")).toBe("");
    expect(await c.stt()).toBeInstanceOf(WhisperCppStt);
  });
});
