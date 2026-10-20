import { connect } from "node:http2";

/** A gRPC call that failed on the server's side, with the status code gRPC gave it. */
export class GrpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GrpcCall {
  /** Server address, e.g. "https://grpc.nvcf.nvidia.com:443". */
  url: string;
  /** "/package.Service/Method". */
  path: string;
  /** The request, already encoded as a protobuf message. */
  message: Buffer;
  /** Extra headers, such as `authorization` and `function-id`. Names must be lower case. */
  metadata?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** gRPC messages travel in frames: a zero byte (not compressed), four bytes of length, then the message. */
export const frame = (message: Buffer): Buffer => {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(message.length, 1);
  return Buffer.concat([head, message]);
};

/** The message in the first frame of a response. */
export function unframe(body: Buffer): Buffer {
  if (body.length < 5) return Buffer.alloc(0);
  if (body[0] !== 0) throw new Error("The service sent a compressed reply, which Murmur doesn't handle.");
  const length = body.readUInt32BE(1);
  return body.subarray(5, 5 + length);
}

/**
 * One request, one reply, over HTTP/2: the only kind of gRPC call Murmur makes. Written against Node's own http2 so
 * no gRPC library is needed. Rejects with a GrpcError when the server answers with a non-zero status.
 */
export function grpcUnary(call: GrpcCall): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = connect(call.url);
    let finished = false;
    const finish = (error?: Error, value?: Buffer) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      call.signal?.removeEventListener("abort", onAbort);
      client.close();
      if (error) reject(error);
      else resolve(value ?? Buffer.alloc(0));
    };
    const timer = setTimeout(() => finish(new Error("The service took too long to answer.")), call.timeoutMs ?? 30_000);
    const onAbort = () => {
      const error = new Error("cancelled");
      error.name = "AbortError";
      finish(error);
    };
    if (call.signal?.aborted) return onAbort();
    call.signal?.addEventListener("abort", onAbort, { once: true });
    client.on("error", (error) => finish(new Error(`Couldn't reach the service: ${error.message}`)));

    const request = client.request({
      ":method": "POST",
      ":path": call.path,
      "content-type": "application/grpc",
      te: "trailers",
      "grpc-accept-encoding": "identity",
      ...call.metadata,
    });
    let httpStatus = 200;
    let status: string | undefined;
    let detail = "";
    const read = (headers: Record<string, unknown>) => {
      if (headers["grpc-status"] !== undefined) status = String(headers["grpc-status"]);
      if (headers["grpc-message"] !== undefined) {
        try {
          detail = decodeURIComponent(String(headers["grpc-message"]));
        } catch {
          detail = String(headers["grpc-message"]);
        }
      }
    };
    const chunks: Buffer[] = [];
    request.on("response", (headers) => {
      httpStatus = Number(headers[":status"] ?? 200);
      read(headers);
    });
    request.on("trailers", (trailers) => read(trailers));
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", (error) => finish(new Error(`Couldn't reach the service: ${error.message}`)));
    request.on("end", () => {
      if (httpStatus === 401 || httpStatus === 403)
        return finish(new GrpcError(16, "The service didn't accept the key."));
      if (httpStatus !== 200) return finish(new Error(`The service said ${httpStatus}.`));
      if (status === undefined) return finish(new Error("The service ended without saying how it went."));
      if (status !== "0") return finish(new GrpcError(Number(status), detail || `gRPC status ${status}`));
      try {
        finish(undefined, unframe(Buffer.concat(chunks)));
      } catch (error) {
        finish(error as Error);
      }
    });
    request.end(frame(call.message));
  });
}
