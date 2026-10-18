import type { SecretStore } from "../secrets/store.js";

/**
 * Sign in with a ChatGPT account using the device-code flow: Murmur shows a short code, the user enters it
 * on OpenAI's page, and Murmur receives tokens for that account. The endpoints below follow the open-source
 * Codex CLI's behavior and are kept in one place because OpenAI can change them.
 */
export const CHATGPT_AUTH = {
  issuer: "https://auth.openai.com",
  /** The public OAuth client id used by Codex sign-in. */
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  /** How long a code stays valid. */
  codeLifetimeMs: 15 * 60 * 1000,
};

export const CHATGPT_TOKEN_KEY = "llm/chatgpt";

export interface ChatGptTokens {
  accessToken: string;
  refreshToken: string;
  accountId?: string;
  email?: string;
  /** Epoch ms after which the access token must be refreshed. */
  expiresAt: number;
}

export interface DeviceCode {
  deviceAuthId: string;
  userCode: string;
  /** Where the user types the code. */
  url: string;
  intervalMs: number;
  expiresAt: number;
}

type Fetch = typeof fetch;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

const json = { "content-type": "application/json" };

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json().catch(() => ({}))) as Record<string, unknown>) ?? {};
}

/** Claims from a JWT payload. Not verified: used only to show the account and to address requests. */
export function jwtClaims(token: string | undefined): Record<string, unknown> {
  const part = token?.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toTokens(body: TokenResponse, previous: ChatGptTokens | undefined, now: number): ChatGptTokens {
  const access = body.access_token ?? previous?.accessToken;
  const refresh = body.refresh_token ?? previous?.refreshToken;
  if (!access || !refresh) throw new Error("The sign-in response had no tokens.");
  const claims = jwtClaims(body.id_token);
  const auth = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const accessAuth = (jwtClaims(access)["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const accountId = (auth.chatgpt_account_id ?? accessAuth.chatgpt_account_id ?? previous?.accountId) as
    string | undefined;
  const email = (claims.email as string | undefined) ?? previous?.email;
  const lifetimeMs = (body.expires_in ?? 3600) * 1000;
  return { accessToken: access, refreshToken: refresh, accountId, email, expiresAt: now + lifetimeMs };
}

export async function requestDeviceCode(fetchImpl: Fetch, now: number): Promise<DeviceCode> {
  const res = await fetchImpl(`${CHATGPT_AUTH.issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ client_id: CHATGPT_AUTH.clientId }),
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(`Couldn't start sign-in (${res.status}).`);
  const deviceAuthId = String(body.device_auth_id ?? "");
  const userCode = String(body.user_code ?? body.usercode ?? "");
  if (!deviceAuthId || !userCode) throw new Error("Couldn't start sign-in: the reply had no code.");
  const interval = Number(body.interval ?? 5);
  return {
    deviceAuthId,
    userCode,
    url: `${CHATGPT_AUTH.issuer}/codex/device`,
    intervalMs: Math.max(1, Number.isFinite(interval) ? interval : 5) * 1000,
    expiresAt: now + CHATGPT_AUTH.codeLifetimeMs,
  };
}

/** One poll. Returns tokens once the user has entered the code, or undefined while the code is still waiting. */
export async function pollDeviceCode(
  fetchImpl: Fetch,
  code: DeviceCode,
  now: number,
): Promise<ChatGptTokens | undefined> {
  const res = await fetchImpl(`${CHATGPT_AUTH.issuer}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ device_auth_id: code.deviceAuthId, user_code: code.userCode }),
  });
  if (res.status === 403 || res.status === 404) return undefined;
  const body = await readJson(res);
  if (!res.ok) throw new Error(`Sign-in failed (${res.status}).`);
  const authorizationCode = String(body.authorization_code ?? "");
  const verifier = String(body.code_verifier ?? "");
  if (!authorizationCode || !verifier) throw new Error("Sign-in failed: the reply was incomplete.");
  const exchange = await fetchImpl(`${CHATGPT_AUTH.issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: `${CHATGPT_AUTH.issuer}/deviceauth/callback`,
      client_id: CHATGPT_AUTH.clientId,
      code_verifier: verifier,
    }).toString(),
  });
  const tokens = (await readJson(exchange)) as TokenResponse;
  if (!exchange.ok) throw new Error(`Sign-in failed (${exchange.status}).`);
  return toTokens(tokens, undefined, now);
}

export async function refreshTokens(fetchImpl: Fetch, tokens: ChatGptTokens, now: number): Promise<ChatGptTokens> {
  const res = await fetchImpl(`${CHATGPT_AUTH.issuer}/oauth/token`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      client_id: CHATGPT_AUTH.clientId,
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      scope: "openid profile email",
    }),
  });
  const body = (await readJson(res)) as TokenResponse;
  if (!res.ok) {
    throw new Error(
      res.status === 400 || res.status === 401
        ? "Your ChatGPT sign-in expired. Sign in again."
        : `Couldn't refresh the sign-in (${res.status}).`,
    );
  }
  return toTokens(body, tokens, now);
}

export interface LoginEvent {
  state: "waiting" | "done" | "failed";
  error?: string;
}

/** Holds the saved sign-in (in the keychain through the shell) and runs one device-code login at a time. */
export class ChatGptSession {
  private tokens: ChatGptTokens | undefined;
  private loaded = false;
  private running: { cancelled: boolean } | undefined;

  constructor(
    private readonly secrets: SecretStore,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async load(): Promise<ChatGptTokens | undefined> {
    if (!this.loaded) {
      const raw = await this.secrets.get(CHATGPT_TOKEN_KEY);
      try {
        this.tokens = raw ? (JSON.parse(raw) as ChatGptTokens) : undefined;
      } catch {
        this.tokens = undefined;
      }
      this.loaded = true;
    }
    return this.tokens;
  }

  private async save(tokens: ChatGptTokens): Promise<void> {
    this.tokens = tokens;
    this.loaded = true;
    await this.secrets.set(CHATGPT_TOKEN_KEY, JSON.stringify(tokens));
  }

  async status(): Promise<{ signedIn: boolean; email?: string }> {
    const tokens = await this.load();
    return { signedIn: Boolean(tokens), email: tokens?.email };
  }

  /** A valid access token and account id, refreshed when it is about to expire. */
  async credentials(forceRefresh = false): Promise<{ accessToken: string; accountId?: string } | undefined> {
    let tokens = await this.load();
    if (!tokens) return undefined;
    if (forceRefresh || tokens.expiresAt - this.now() < 60_000) {
      tokens = await refreshTokens(this.fetchImpl, tokens, this.now());
      await this.save(tokens);
    }
    return { accessToken: tokens.accessToken, accountId: tokens.accountId };
  }

  async logout(): Promise<void> {
    if (this.running) this.running.cancelled = true;
    this.tokens = undefined;
    this.loaded = true;
    await this.secrets.delete(CHATGPT_TOKEN_KEY);
  }

  cancel(): void {
    if (this.running) this.running.cancelled = true;
  }

  /** Starts a login and returns the code to show. Progress is reported through `onEvent`. */
  async startLogin(
    onEvent: (event: LoginEvent) => void,
  ): Promise<{ userCode: string; url: string; expiresInSeconds: number }> {
    this.cancel();
    const code = await requestDeviceCode(this.fetchImpl, this.now());
    const run = { cancelled: false };
    this.running = run;
    void this.poll(code, run, onEvent);
    onEvent({ state: "waiting" });
    return {
      userCode: code.userCode,
      url: code.url,
      expiresInSeconds: Math.round((code.expiresAt - this.now()) / 1000),
    };
  }

  private async poll(
    code: DeviceCode,
    run: { cancelled: boolean },
    onEvent: (event: LoginEvent) => void,
  ): Promise<void> {
    try {
      while (!run.cancelled) {
        if (this.now() > code.expiresAt) throw new Error("The code expired. Start again.");
        await this.sleep(code.intervalMs);
        if (run.cancelled) return;
        const tokens = await pollDeviceCode(this.fetchImpl, code, this.now());
        if (tokens) {
          await this.save(tokens);
          if (this.running === run) this.running = undefined;
          onEvent({ state: "done" });
          return;
        }
      }
    } catch (error) {
      if (this.running === run) this.running = undefined;
      onEvent({ state: "failed", error: (error as Error).message });
    }
  }
}
