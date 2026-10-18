import { describe, expect, it } from "vitest";
import {
  CHATGPT_AUTH,
  CHATGPT_TOKEN_KEY,
  ChatGptSession,
  jwtClaims,
  type LoginEvent,
} from "../src/providers/chatgpt-auth.js";
import { ChatGptCodexLlm, CHATGPT_RESPONSES_URL } from "../src/providers/chatgpt-codex.js";
import { MemorySecretStore } from "../src/secrets/store.js";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: unknown) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const idToken = jwt({ email: "me@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } });

function authFetch(pollsBeforeDone: number) {
  let polls = 0;
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/deviceauth/usercode"))
      return reply({ device_auth_id: "dev1", user_code: "ABCD-1234", interval: "1" });
    if (u.endsWith("/deviceauth/token")) {
      return ++polls <= pollsBeforeDone
        ? reply({}, 403)
        : reply({ authorization_code: "authcode", code_verifier: "ver" });
    }
    if (u.endsWith("/oauth/token")) {
      return reply({ access_token: "access-1", refresh_token: "refresh-1", id_token: idToken, expires_in: 3600 });
    }
    return reply({}, 500);
  }) as typeof fetch;
  return { impl, calls };
}

describe("ChatGPT sign-in", () => {
  it("shows a code, waits for approval, then saves tokens in the secret store", async () => {
    const secrets = new MemorySecretStore();
    const { impl, calls } = authFetch(2);
    const events: LoginEvent[] = [];
    let clock = 1_000;
    const session = new ChatGptSession(
      secrets,
      impl,
      () => clock,
      async () => void (clock += 1000),
    );
    const done = new Promise<void>((resolve) => {
      void session
        .startLogin((e) => {
          events.push(e);
          if (e.state !== "waiting") resolve();
        })
        .then((code) => {
          expect(code.userCode).toBe("ABCD-1234");
          expect(code.url).toBe(`${CHATGPT_AUTH.issuer}/codex/device`);
        });
    });
    await done;
    expect(events.map((e) => e.state)).toEqual(["waiting", "done"]);
    expect(calls.filter((c) => c.endsWith("/deviceauth/token"))).toHaveLength(3);
    expect(await session.status()).toEqual({ signedIn: true, email: "me@example.com" });
    const saved = JSON.parse((await secrets.get(CHATGPT_TOKEN_KEY)) ?? "{}") as { accountId: string };
    expect(saved.accountId).toBe("acct_1");
  });

  it("reports a failure when the code expires", async () => {
    let clock = 0;
    const { impl } = authFetch(1000);
    const session = new ChatGptSession(
      new MemorySecretStore(),
      impl,
      () => clock,
      async () => void (clock += CHATGPT_AUTH.codeLifetimeMs),
    );
    const failed = new Promise<LoginEvent>((resolve) => {
      void session.startLogin((e) => e.state === "failed" && resolve(e));
    });
    expect((await failed).error).toMatch(/expired/);
    expect((await session.status()).signedIn).toBe(false);
  });

  it("refreshes an expiring token and keeps the new one", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(
      CHATGPT_TOKEN_KEY,
      JSON.stringify({ accessToken: "old", refreshToken: "r0", accountId: "acct_1", expiresAt: 1000 }),
    );
    const impl = (async () =>
      reply({ access_token: "new", refresh_token: "r1", expires_in: 3600 })) as unknown as typeof fetch;
    const session = new ChatGptSession(secrets, impl, () => 2000);
    expect(await session.credentials()).toEqual({ accessToken: "new", accountId: "acct_1" });
    expect(JSON.parse((await secrets.get(CHATGPT_TOKEN_KEY)) ?? "{}")).toMatchObject({
      refreshToken: "r1",
      accountId: "acct_1",
    });
  });

  it("sign out removes the tokens", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(CHATGPT_TOKEN_KEY, JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 9e12 }));
    const session = new ChatGptSession(secrets);
    expect((await session.status()).signedIn).toBe(true);
    await session.logout();
    expect((await session.status()).signedIn).toBe(false);
    expect(await secrets.get(CHATGPT_TOKEN_KEY)).toBeUndefined();
  });

  it("reads claims without verifying", () => {
    expect(jwtClaims(idToken).email).toBe("me@example.com");
    expect(jwtClaims("nonsense")).toEqual({});
  });
});

const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

async function signedInSession() {
  const secrets = new MemorySecretStore();
  await secrets.set(
    CHATGPT_TOKEN_KEY,
    JSON.stringify({ accessToken: "tok", refreshToken: "r", accountId: "acct_1", expiresAt: 9e12 }),
  );
  return new ChatGptSession(secrets, (async () => reply({}, 500)) as unknown as typeof fetch);
}

describe("ChatGptCodexLlm", () => {
  it("sends a Responses request and reads text and tool calls from the stream", async () => {
    let seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      return sse([
        { type: "response.output_text.delta", delta: "Opening " },
        { type: "response.output_text.delta", delta: "it." },
        {
          type: "response.output_item.done",
          item: { type: "function_call", call_id: "c1", name: "files__open", arguments: '{"path":"/a"}' },
        },
        { type: "response.completed" },
      ]);
    }) as unknown as typeof fetch;
    const llm = new ChatGptCodexLlm({ session: await signedInSession(), fetch: fetchImpl });
    const out = await llm.complete({
      system: "be brief",
      messages: [
        { role: "user", text: "open a" },
        { role: "assistant", text: "", toolCalls: [{ id: "c0", name: "files.list", input: {} }] },
        { role: "tool", results: [{ id: "c0", content: "a, b" }] },
      ],
      tools: [{ name: "files.open", description: "Open", inputSchema: { type: "object" }, origin: "builtin" }],
    });
    expect(out.text).toBe("Opening it.");
    expect(out.toolCalls).toEqual([{ id: "c1", name: "files.open", input: { path: "/a" } }]);
    expect(seen?.url).toBe(CHATGPT_RESPONSES_URL);
    expect(seen?.headers.authorization).toBe("Bearer tok");
    expect(seen?.headers["chatgpt-account-id"]).toBe("acct_1");
    expect(seen?.body).toMatchObject({ stream: true, store: false, instructions: "be brief" });
    const input = seen?.body.input as Array<Record<string, unknown>>;
    expect(input.map((i) => i.type)).toEqual(["message", "function_call", "function_call_output"]);
    expect(input[1]).toMatchObject({ name: "files__list", call_id: "c0" });
  });

  it("explains a failed request without leaking the token", async () => {
    const fetchImpl = (async () => reply({ error: { message: "plan limit reached" } }, 429)) as unknown as typeof fetch;
    const llm = new ChatGptCodexLlm({ session: await signedInSession(), fetch: fetchImpl });
    await expect(llm.complete({ system: "", messages: [{ role: "user", text: "hi" }] })).rejects.toThrow(
      /429.*plan limit reached/,
    );
  });

  it("says so when nobody is signed in", async () => {
    const llm = new ChatGptCodexLlm({ session: new ChatGptSession(new MemorySecretStore()) });
    await expect(llm.complete({ system: "", messages: [] })).rejects.toThrow(/sign in/i);
  });
});
