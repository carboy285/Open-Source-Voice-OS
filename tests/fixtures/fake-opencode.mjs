#!/usr/bin/env node
// A stand-in for `opencode serve`: a small HTTP server with basic auth, a session list and an event stream.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const log = (entry) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`);
const scenario = process.env.FAKE_SCENARIO ?? "command";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const expected = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
log({ argv: args, cwd: process.cwd(), hasPassword: Boolean(process.env.OPENCODE_SERVER_PASSWORD) });

const streams = new Set();
const emit = (type, properties) => {
  for (const res of streams) res.write(`data: ${JSON.stringify({ id: "evt", type, properties })}\n\n`);
};
const pending = new Map();

const body = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
  });

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.headers.authorization !== expected) {
    res.writeHead(401).end();
    return;
  }
  log({ request: `${req.method} ${url.pathname}` });
  if (url.pathname === "/global/health") res.writeHead(200).end('{"healthy":true}');
  else if (url.pathname === "/event") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "evt0", type: "server.connected", properties: {} })}\n\n`);
    streams.add(res);
    req.on("close", () => streams.delete(res));
  } else if (req.method === "POST" && url.pathname === "/session") {
    const b = await body(req);
    log({ sessionBody: b });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "ses1" }));
  } else if (req.method === "POST" && url.pathname === "/session/ses1/message") {
    const b = await body(req);
    log({ message: b.parts[0].text });
    if (scenario === "error") {
      emit("session.error", {
        sessionID: "ses1",
        error: { name: "ProviderAuthError", data: { message: "Token refresh failed: 401" } },
      });
      res.writeHead(200).end("{}");
      return;
    }
    const reply = await new Promise((resolve) => {
      pending.set("per1", resolve);
      emit("permission.asked", {
        id: "per1",
        sessionID: "ses1",
        permission: "bash",
        patterns: [scenario === "risky" ? "git push --force" : "npm test"],
      });
    });
    log({ reply });
    emit("message.part.updated", {
      sessionID: "ses1",
      part: { id: "p1", type: "text", text: reply === "once" ? "Ran it." : "Did not run it." },
    });
    emit("session.idle", { sessionID: "ses1" });
    res.writeHead(200).end("{}");
  } else if (req.method === "POST" && url.pathname === "/permission/per1/reply") {
    const b = await body(req);
    pending.get("per1")?.(b.reply);
    res.writeHead(200).end("true");
  } else if (req.method === "POST" && url.pathname.endsWith("/abort")) {
    log({ aborted: true });
    res.writeHead(200).end("true");
  } else res.writeHead(404).end();
}).listen(port, "127.0.0.1");
