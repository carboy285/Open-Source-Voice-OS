import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpToolHost } from "../src/mcp/host.js";

let host: McpToolHost;

beforeAll(async () => {
  host = await McpToolHost.connect({
    servers: { fx: { command: process.execPath, args: [resolve("tests/fixtures/mcp-server.mjs")] } },
  });
});
afterAll(() => host.close());

describe("McpToolHost", () => {
  it("namespaces tools and marks only annotated ones read-only", async () => {
    const tools = await host.list();
    expect(tools.map((t) => [t.name, t.readOnly])).toEqual(
      expect.arrayContaining([["fx__echo", true], ["fx__send", false], ["fx__boom", false]]),
    );
  });

  it("calls tools and surfaces tool errors", async () => {
    expect(await host.call("fx__echo", { text: "hi" })).toBe("echo:hi");
    await expect(host.call("fx__boom", {})).rejects.toThrow("kaboom");
    await expect(host.call("nope__x", {})).rejects.toThrow(/Unknown tool/);
  });
});
