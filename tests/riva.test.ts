import { createServer, type Http2Server, type ServerHttp2Stream, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { STT_PRESETS } from "../src/providers/catalog.js";
import { CloudStt } from "../src/providers/cloud-stt.js";
import { frame, grpcUnary, unframe } from "../src/providers/grpc.js";
import { RIVA_RECOGNIZE, decodeRecognize, encodeRecognize } from "../src/providers/riva.js";

const len = (n: number) => Buffer.from([n]);
const lenField = (field: number, body: Buffer) =>
  Buffer.concat([Buffer.from([(field << 3) | 2]), len(body.length), body]);
/** A RecognizeResponse as NVIDIA's server would send it: results → alternatives → transcript. */
const response = (...texts: string[]) =>
  Buffer.concat(
    texts.map((t) =>
      lenField(1, lenField(1, Buffer.concat([lenField(1, Buffer.from(t)), Buffer.from([0x15, 0, 0, 0x80, 0x3f])]))),
    ),
  );

const servers: Http2Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

interface Seen {
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A tiny gRPC server on this computer, over plain HTTP/2. */
async function serve(answer: (seen: Seen, stream: ServerHttp2Stream) => void) {
  const seen: Seen[] = [];
  const server = createServer();
  servers.push(server);
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      const entry = { headers, body: Buffer.concat(chunks) };
      seen.push(entry);
      answer(entry, stream as ServerHttp2Stream);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const ok =
  (...texts: string[]) =>
  (_: Seen, stream: ServerHttp2Stream) => {
    stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    stream.end(frame(response(...texts)));
  };
const fail =
  (code: number, message = "") =>
  (_: Seen, stream: ServerHttp2Stream) => {
    stream.respond(
      {
        ":status": 200,
        "content-type": "application/grpc",
        "grpc-status": String(code),
        "grpc-message": encodeURIComponent(message),
      },
      { endStream: true },
    );
  };

const audio = { pcm: new Uint8Array(32000).fill(7), sampleRate: 16000 };
const nvidia = STT_PRESETS.find((p) => p.id === "nvidia-hosted")!;

describe("Riva messages", () => {
  it("reads the text of each result and joins them", () => {
    expect(decodeRecognize(response("hello there", "and more"))).toBe("hello there and more");
    expect(decodeRecognize(Buffer.alloc(0))).toBe("");
  });

  it("writes a request with the config first and the audio second", () => {
    const message = encodeRecognize(new Uint8Array([1, 2, 3]), 16000, "en-US");
    // config: encoding 1, rate 16000, language, one alternative, punctuation on.
    expect(message[0]).toBe(0x0a);
    const configLength = message[1]!;
    const config = message.subarray(2, 2 + configLength);
    expect(config.subarray(0, 2)).toEqual(Buffer.from([0x08, 0x01]));
    expect(config.includes(Buffer.from("en-US"))).toBe(true);
    expect(config.subarray(config.length - 4)).toEqual(Buffer.from([0x20, 0x01, 0x58, 0x01]));
    expect(message.subarray(2 + configLength)).toEqual(Buffer.from([0x12, 3, 1, 2, 3]));
  });
});

describe("gRPC over HTTP/2", () => {
  it("frames a message with a length and sends the headers it was given", async () => {
    const server = await serve(ok("hi"));
    const reply = await grpcUnary({
      url: server.url,
      path: RIVA_RECOGNIZE,
      message: Buffer.from("abc"),
      metadata: { "function-id": "fn-1", authorization: "Bearer k" },
    });
    expect(decodeRecognize(reply)).toBe("hi");
    const call = server.seen[0]!;
    expect(call.headers[":path"]).toBe("/nvidia.riva.asr.RivaSpeechRecognition/Recognize");
    expect(call.headers["content-type"]).toBe("application/grpc");
    expect(call.headers["function-id"]).toBe("fn-1");
    expect(call.headers.authorization).toBe("Bearer k");
    expect(unframe(call.body)).toEqual(Buffer.from("abc"));
  });

  it("turns a non-zero status into an error, and can be cancelled", async () => {
    const refused = await serve(fail(16, "bad key"));
    await expect(grpcUnary({ url: refused.url, path: "/x/y", message: Buffer.alloc(0) })).rejects.toMatchObject({
      code: 16,
      message: "bad key",
    });
    const slow = await serve(() => {});
    const controller = new AbortController();
    const pending = grpcUnary({ url: slow.url, path: "/x/y", message: Buffer.alloc(0), signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("NVIDIA hosted speech", () => {
  const provider = (url: string, over: Partial<ConstructorParameters<typeof CloudStt>[0]> = {}) =>
    new CloudStt({
      api: nvidia.api,
      url,
      model: "",
      apiKey: "nvapi-secret",
      functionId: " b702f636-f60c-4a3d-a6f4-f3568c13bd7d ",
      ...over,
    });

  it("is offered with the key and Function ID it needs", () => {
    expect(nvidia).toMatchObject({ api: "riva", url: "https://grpc.nvcf.nvidia.com:443" });
  });

  it("sends the audio with the key and Function ID in headers, and returns the text", async () => {
    const server = await serve(ok("good morning"));
    const result = await provider(server.url).transcribe(audio, { language: "ja" });
    expect(result.text).toBe("good morning");
    const call = server.seen[0]!;
    expect(call.headers["function-id"]).toBe("b702f636-f60c-4a3d-a6f4-f3568c13bd7d");
    expect(call.headers.authorization).toBe("Bearer nvapi-secret");
    const message = unframe(call.body);
    expect(message.includes(Buffer.from("ja-JP"))).toBe(true);
    expect(message.length).toBeGreaterThan(32000);
  });

  it("asks for the Function ID when it is missing, and explains a refused key or a wrong ID", async () => {
    await expect(provider("http://127.0.0.1:1", { functionId: "" }).transcribe(audio)).rejects.toThrow(/Function ID/);
    const refused = await serve(fail(16, "nvapi-secret is not valid"));
    const error = await provider(refused.url)
      .transcribe(audio)
      .catch((e: Error) => e);
    expect((error as Error).message).toMatch(/didn't accept the key or the Function ID/);
    expect((error as Error).message).not.toContain("nvapi-secret");
    const unknown = await serve(fail(5, "no such function"));
    await expect(provider(unknown.url).transcribe(audio)).rejects.toThrow(/doesn't know that Function ID/);
    const other = await serve(fail(13, "busy nvapi-secret"));
    const busy = await provider(other.url)
      .transcribe(audio)
      .catch((e: Error) => e);
    expect((busy as Error).message).toMatch(/speech service said: busy/);
    expect((busy as Error).message).not.toContain("nvapi-secret");
  });
});
