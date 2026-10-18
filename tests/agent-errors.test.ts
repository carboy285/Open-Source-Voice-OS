import { describe, expect, it } from "vitest";
import type { LlmProvider } from "../src/core/types.js";
import { describeError, redactSecrets } from "../src/core/redact.js";
import { ApprovalGate } from "../src/gate/gate.js";
import { runAgent } from "../src/modes/agent.js";
import { ScriptedApprovalUi } from "./fakes/approval.js";
import { RecordingToolHost, searchFiles } from "./fakes/tools.js";

const KEY = "nvapi-Zq81kdLw03PxYt6VbN2mA9sR";

function failingLlm(error: unknown): LlmProvider {
  return { complete: async () => Promise.reject(error) };
}

describe("agent model errors", () => {
  it("says why the model request failed, without the key", async () => {
    const llm = failingLlm(new Error(`Model request failed (401): Invalid API key ${KEY} for Bearer ${KEY}`));
    const result = await runAgent(
      "hi",
      llm,
      new RecordingToolHost([searchFiles]),
      new ApprovalGate(new ScriptedApprovalUi([])),
    );
    expect(result.status).toBe("failed");
    expect(result.reply).toMatch(/^The model request failed: Model request failed \(401\): Invalid API key/);
    expect(result.reply).not.toContain(KEY);
    expect(result.reply).not.toContain("Zq81kdLw03");
  });

  it("includes a network cause from fetch", () => {
    const error = new Error("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND integrate.api.example.com") });
    expect(describeError(error)).toBe("fetch failed (getaddrinfo ENOTFOUND integrate.api.example.com)");
  });

  it("redacts common token shapes", () => {
    expect(redactSecrets("key sk-ant-api03-abcdefghij123")).toBe("key [redacted]");
    expect(redactSecrets("Authorization: Bearer abc.def-123456")).toBe("Authorization: Bearer [redacted]");
    expect(redactSecrets(`token ${"a".repeat(40)}`)).toBe("token [redacted]");
    expect(redactSecrets("Model request failed (404): model not found")).toBe(
      "Model request failed (404): model not found",
    );
  });
});
