#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json`.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (entry) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const scenario = process.env.FAKE_SCENARIO ?? "command";
log({ argv: process.argv.slice(2), cwd: process.cwd() });

const waiting = new Map();
let n = 0;

createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_response") {
    waiting.get(message.response.request_id)?.(message.response);
    return;
  }
  if (message.type !== "user") return;
  const text = message.message.content[0].text;
  log({ user: text });
  if (scenario === "login") {
    send({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Not logged in. Run claude auth login.",
    });
    return;
  }
  const input = scenario === "risky" ? { command: "git push --force origin main" } : { command: "npm test" };
  send({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input }] } });
  const requestId = `req-${++n}`;
  const response = await new Promise((resolve) => {
    waiting.set(requestId, resolve);
    send({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "can_use_tool", tool_name: "Bash", input },
    });
  });
  log({ behavior: response.response?.behavior, updatedInput: response.response?.updatedInput });
  const said = response.response?.behavior === "allow" ? "Tests passed." : "Skipped the tests.";
  send({ type: "assistant", message: { content: [{ type: "text", text: said }] } });
  send({ type: "result", subtype: "success", is_error: false, result: said });
});
