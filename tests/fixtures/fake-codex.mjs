#!/usr/bin/env node
// A stand-in for `codex app-server`: JSON lines over stdio, no "jsonrpc" field, like the real one.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (entry) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const scenario = process.env.FAKE_SCENARIO ?? "command";
log({ argv: process.argv.slice(2), cwd: process.cwd() });

let nextServerId = 100;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

async function runTurn(text) {
  send({ method: "turn/started", params: { threadId: "t1" } });
  let said = "All done.";
  if (scenario === "command" || scenario === "risky") {
    const command = scenario === "risky" ? "rm -rf build" : "npm test";
    send({ method: "item/started", params: { item: { type: "commandExecution", command, cwd: process.cwd() } } });
    const reply = await ask("item/commandExecution/requestApproval", {
      command,
      cwd: process.cwd(),
      itemId: "i1",
      threadId: "t1",
      turnId: "u1",
    });
    log({ decision: reply.result?.decision, error: reply.error?.message });
    said = reply.result?.decision === "accept" ? `Ran ${command}.` : `Did not run ${command}.`;
  } else if (scenario === "files") {
    const reply = await ask("item/fileChange/requestApproval", {
      reason: "Update the README",
      threadId: "t1",
      turnId: "u1",
      itemId: "i2",
    });
    log({ decision: reply.result?.decision });
    said = reply.result?.decision === "accept" ? "Changed the files." : "Left the files alone.";
  } else if (scenario === "question") {
    const reply = await ask("item/tool/requestUserInput", {
      questions: [{ question: "Which branch?" }],
      threadId: "t1",
      turnId: "u1",
      itemId: "i3",
    });
    log({ questionReply: reply });
    said = "Carrying on without an answer.";
  } else if (scenario === "fail") {
    send({ method: "error", params: { error: { message: "You are out of credits." } } });
    return;
  }
  send({ method: "item/completed", params: { item: { type: "agentMessage", text: `${said} (${text})` } } });
  send({ method: "turn/completed", params: { threadId: "t1" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  log({ method: message.method, params: message.params });
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake-codex" } });
  else if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "t1" } } });
  else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "u1" } } });
    void runTurn(message.params.input[0].text);
  } else if (message.method === "turn/interrupt") send({ id: message.id, result: {} });
});
