import { describe, expect, it } from "vitest";
import { ApprovalGate } from "../src/gate/gate.js";
import { AGENT_SYSTEM, currentTimeBlock, runAgent } from "../src/modes/agent.js";
import { ScriptedApprovalUi } from "./fakes/approval.js";
import { ScriptedLlm } from "./fakes/llm.js";
import { RecordingToolHost } from "./fakes/tools.js";

// Sunday 18 October 2026, 18:42 UTC.
const NOW = Date.UTC(2026, 9, 18, 18, 42);

describe("the agent's clock", () => {
  it("says the date, weekday, zone and offset in the user's zone", () => {
    expect(currentTimeBlock(NOW, "UTC")).toBe(
      "Now: Sunday 2026-10-18 18:42 (UTC, UTC+00:00). Today is 2026-10-18; tomorrow is 2026-10-19.",
    );
    expect(currentTimeBlock(NOW, "America/Los_Angeles")).toBe(
      "Now: Sunday 2026-10-18 11:42 (America/Los_Angeles, UTC-07:00). Today is 2026-10-18; tomorrow is 2026-10-19.",
    );
  });

  it("rolls the date over where it is already tomorrow", () => {
    expect(currentTimeBlock(NOW, "Asia/Tokyo")).toBe(
      "Now: Monday 2026-10-19 03:42 (Asia/Tokyo, UTC+09:00). Today is 2026-10-19; tomorrow is 2026-10-20.",
    );
  });

  it("follows daylight saving time and half-hour zones", () => {
    const winter = Date.UTC(2026, 0, 15, 12, 0);
    expect(currentTimeBlock(winter, "America/Los_Angeles")).toContain("UTC-08:00");
    expect(currentTimeBlock(NOW, "Asia/Kolkata")).toContain("UTC+05:30");
  });

  it("gives the right 'tomorrow' just before local midnight", () => {
    const lateLocal = Date.UTC(2026, 9, 19, 6, 30); // 23:30 on the 18th in Los Angeles
    expect(currentTimeBlock(lateLocal, "America/Los_Angeles")).toBe(
      "Now: Sunday 2026-10-18 23:30 (America/Los_Angeles, UTC-07:00). Today is 2026-10-18; tomorrow is 2026-10-19.",
    );
  });

  it("is in the first request the model sees, and the prompt says to use it", async () => {
    const llm = new ScriptedLlm([{ text: "Nothing today.", toolCalls: [] }]);
    await runAgent(
      "what's on my calendar today",
      llm,
      new RecordingToolHost([]),
      new ApprovalGate(new ScriptedApprovalUi([])),
      { clock: { now: () => NOW }, timeZone: "Asia/Tokyo" },
    );
    const first = llm.requests[0]!.messages[0]!;
    expect(first.role === "user" && first.text).toContain("Today is 2026-10-19");
    expect(first.role === "user" && first.text).toContain("Request: what's on my calendar today");
    expect(AGENT_SYSTEM).toContain('The "Now" line');
    expect(AGENT_SYSTEM).toContain("Never guess or assume a date");
  });
});
