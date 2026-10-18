import { describe, expect, it } from "vitest";
import { MurmurCore } from "../src/core/app.js";
import { MemorySecretStore } from "../src/secrets/store.js";
import { ScriptedApprovalUi } from "./fakes/approval.js";
import { fakeFetch } from "./fakes/connectors.js";

describe("connector OAuth flow", () => {
  it("runs PKCE through the loopback redirect and stores tokens in the keychain", async () => {
    const secrets = new MemorySecretStore();
    const token = fakeFetch(() => ({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
    const core = new MurmurCore({
      databasePath: ":memory:",
      mcpConfigPath: "/nonexistent/mcp.json",
      fetch: token.fn,
      bridge: {
        insertText: async () => ({ ok: true, method: "test" }),
        captureContext: async () => ({}),
        secrets,
        approvals: new ScriptedApprovalUi([]),
        emit: () => {},
      },
    });
    core.settings.set("connectors.settings", { gmail: { clientId: "my-client" } });
    let opened = "";
    await core.authorizeConnector("gmail", async (url) => {
      opened = url;
      const state = new URL(url).searchParams.get("state");
      await fetch(`http://127.0.0.1:${MurmurCore.OAUTH_PORT}/callback?code=the-code&state=${state}`);
    });
    const params = new URL(opened).searchParams;
    expect(params.get("client_id")).toBe("my-client");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(String(token.calls[0]!.init!.body)).toContain("code=the-code");
    expect(String(token.calls[0]!.init!.body)).toContain("code_verifier=");
    expect(JSON.parse(secrets.values.get("connector/gmail/token")!)).toMatchObject({
      accessToken: "at",
      refreshToken: "rt",
    });
    await core.close();
  });

  it("asks for a client ID first", async () => {
    const core = new MurmurCore({
      databasePath: ":memory:",
      mcpConfigPath: "/nonexistent/mcp.json",
      bridge: {
        insertText: async () => ({ ok: true, method: "test" }),
        captureContext: async () => ({}),
        secrets: new MemorySecretStore(),
        approvals: new ScriptedApprovalUi([]),
        emit: () => {},
      },
    });
    await expect(core.authorizeConnector("gmail", async () => {})).rejects.toThrow(/client ID/);
    await core.close();
  });
});
