import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { findModel, MODEL_BASE_URL, MODELS, type SpeechModel } from "./catalog.js";

export interface InstalledModel extends SpeechModel {
  installed: boolean;
  path: string;
  bytes?: number;
}

export interface DownloadProgress {
  id: string;
  received: number;
  total?: number;
}

/**
 * Downloads speech models into Murmur's data folder (`models/`). Each file is checked against the
 * SHA-256 that Hugging Face publishes for it (the `x-linked-etag` header on the file's redirect),
 * written to a `.partial` file first and renamed only when the hash matches.
 */
export class ModelManager {
  private readonly active = new Map<string, AbortController>();

  constructor(
    readonly dir: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = MODEL_BASE_URL,
  ) {}

  path(id: string): string | undefined {
    const model = findModel(id);
    return model ? join(this.dir, model.file) : undefined;
  }

  isInstalled(id: string): boolean {
    const path = this.path(id);
    return path !== undefined && existsSync(path);
  }

  isDownloading(id: string): boolean {
    return this.active.has(id);
  }

  list(): InstalledModel[] {
    return MODELS.map((model) => {
      const path = join(this.dir, model.file);
      const installed = existsSync(path);
      return { ...model, path, installed, ...(installed ? { bytes: statSync(path).size } : {}) };
    });
  }

  async download(id: string, onProgress?: (progress: DownloadProgress) => void): Promise<string> {
    const model = findModel(id);
    if (!model) throw new Error(`Unknown model: ${id}`);
    if (this.active.has(id)) throw new Error(`${model.name} is already downloading.`);
    const controller = new AbortController();
    this.active.set(id, controller);
    const final = join(this.dir, model.file);
    const partial = `${final}.partial`;
    try {
      mkdirSync(this.dir, { recursive: true });
      const url = this.baseUrl + model.file;
      const expected = await this.expectedHash(url, controller.signal);

      const response = await this.fetchImpl(url, { signal: controller.signal, redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}).`);
      const total = Number(response.headers.get("content-length")) || undefined;
      const hash = createHash("sha256");
      let received = 0;
      let lastReport = 0;
      const body = Readable.fromWeb(response.body as WebReadableStream);
      body.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        received += chunk.length;
        const now = Date.now();
        if (now - lastReport > 250) {
          lastReport = now;
          onProgress?.({ id, received, total });
        }
      });
      await pipeline(body, createWriteStream(partial), { signal: controller.signal });
      onProgress?.({ id, received, total });

      const actual = hash.digest("hex");
      if (actual !== expected)
        throw new Error("The downloaded model didn't match its published checksum, so it was discarded.");
      renameSync(partial, final);
      return final;
    } catch (error) {
      rmSync(partial, { force: true });
      if (controller.signal.aborted) throw new Error("Download cancelled.");
      throw error;
    } finally {
      this.active.delete(id);
    }
  }

  cancel(id: string): void {
    this.active.get(id)?.abort();
  }

  remove(id: string): void {
    const path = this.path(id);
    if (path) rmSync(path, { force: true });
  }

  /** Hugging Face answers a file URL with a redirect whose `x-linked-etag` header is the file's SHA-256. */
  private async expectedHash(url: string, signal: AbortSignal): Promise<string> {
    const head = await this.fetchImpl(url, { method: "HEAD", redirect: "manual", signal });
    const etag = (head.headers.get("x-linked-etag") ?? head.headers.get("etag") ?? "")
      .replace(/^W\//, "")
      .replace(/"/g, "");
    if (!/^[0-9a-f]{64}$/i.test(etag)) {
      throw new Error("The model host didn't publish a checksum for this file, so Murmur won't download it.");
    }
    return etag.toLowerCase();
  }
}
