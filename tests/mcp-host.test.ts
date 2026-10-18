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

  it("keeps long tool names distinct and routes each to its exact tool", async () => {
    const tools = (await host.list()).filter((t) => t.description.startsWith("Long "));
    expect(new Set(tools.map((t) => t.name)).size).toBe(2);
    for (const tool of tools) {
      expect(tool.name.length).toBeLessThanOrEqual(64);
      expect(await host.call(tool.name, {})).toBe(tool.readOnly ? "read" : "write");
    }
    expect((await host.list()).filter((t) => t.description.startsWith("Long ")).map((t) => t.name))
      .toEqual(tools.map((t) => t.name));
  });

  it("routes server names containing the namespace separator", async () => {
    const nested = await McpToolHost.connect({
      servers: { a__b: { command: process.execPath, args: [resolve("tests/fixtures/mcp-server.mjs")] } },
    });
    try {
      await nested.list();
      expect(await nested.call("a__b__echo", { text: "hi" })).toBe("echo:hi");
    } finally {
      await nested.close();
    }
  });

  it("discovers all pages and can call a tool from the second page", async () => {
    const paged = await McpToolHost.connect({
      servers: { pages: { command: process.execPath, args: [resolve("tests/fixtures/paged-mcp-server.mjs")] } },
    });
    try {
      expect((await paged.list()).map((t) => t.name)).toEqual(["pages__first", "pages__second"]);
      expect(await paged.call("pages__second", {})).toBe("called second");
    } finally {
      await paged.close();
    }
  });

  it("disambiguates the same combined namespace from different servers", async () => {
    const server = { command: process.execPath, args: [resolve("tests/fixtures/mcp-server.mjs")] };
    const ambiguous = await McpToolHost.connect({ servers: { a: server, a__b: server } });
    try {
      const tools = await ambiguous.list();
      expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
      const colliding = tools.filter((t) => t.name.startsWith("a__b__echo_"));
      expect(colliding).toHaveLength(2);
      for (const tool of colliding) {
        expect(await ambiguous.call(tool.name, { text: "hi" }))
          .toBe(tool.description === "Echo text" ? "echo:hi" : "nested tool");
      }
    } finally {
      await ambiguous.close();
    }
  });
});
