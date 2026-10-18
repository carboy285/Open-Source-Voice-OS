import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { SecretStore } from "../secrets/store.js";

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** RFC 7636 verifier (43–128 chars) and its S256 challenge. */
export function createPkce(bytes = 32): PkcePair {
  const verifier = b64url(randomBytes(bytes));
  return { verifier, challenge: pkceChallenge(verifier), method: "S256" };
}

export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  redirectUri: string;
  extraParams?: Record<string, string>;
}

export function authorizeUrl(config: OAuthConfig, pkce: PkcePair, state: string): string {
  const url = new URL(config.authorizeUrl);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(" "),
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: pkce.method,
    ...config.extraParams,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
}

async function tokenRequest(
  config: OAuthConfig,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
  now: number,
): Promise<TokenSet> {
  const response = await fetchImpl(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: config.clientId, ...body }).toString(),
  });
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok || typeof json.access_token !== "string") {
    throw new Error(`Token request failed: ${String(json.error_description ?? json.error ?? response.status)}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : body.refresh_token,
    expiresAt: typeof json.expires_in === "number" ? now + json.expires_in * 1000 : undefined,
  };
}

export function exchangeCode(config: OAuthConfig, code: string, verifier: string, fetchImpl = fetch, now = Date.now()) {
  return tokenRequest(
    config,
    { grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: verifier },
    fetchImpl,
    now,
  );
}

export function refreshToken(config: OAuthConfig, refresh: string, fetchImpl = fetch, now = Date.now()) {
  return tokenRequest(config, { grant_type: "refresh_token", refresh_token: refresh }, fetchImpl, now);
}

export const tokenKey = (connectorId: string) => `connector/${connectorId}/token`;

export async function saveTokens(secrets: SecretStore, connectorId: string, tokens: TokenSet): Promise<void> {
  await secrets.set(tokenKey(connectorId), JSON.stringify(tokens));
}

/** Returns a valid access token, refreshing it when it expires within a minute. */
export async function accessToken(
  secrets: SecretStore,
  connectorId: string,
  config?: OAuthConfig,
  fetchImpl = fetch,
  now = Date.now(),
): Promise<string | undefined> {
  const raw = await secrets.get(tokenKey(connectorId));
  if (!raw) return undefined;
  const tokens = JSON.parse(raw) as TokenSet;
  if (tokens.expiresAt && tokens.expiresAt - 60_000 < now && tokens.refreshToken && config) {
    const next = await refreshToken(config, tokens.refreshToken, fetchImpl, now);
    await saveTokens(secrets, connectorId, next);
    return next.accessToken;
  }
  return tokens.accessToken;
}

/**
 * Waits for the browser redirect on a loopback port and returns the code.
 * Rejects on state mismatch, an error parameter, or after `timeoutMs`.
 */
export function waitForRedirect(
  port: number,
  expectedState: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<{ code: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<p>Murmur is connected. You can close this tab.</p>");
      clearTimeout(timer);
      server.close();
      if (error) reject(new Error(`Authorization failed: ${error}`));
      else if (!code || state !== expectedState) reject(new Error("Authorization failed: state mismatch"));
      else resolve({ code, close: () => server.close() });
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Authorization timed out"));
    }, timeoutMs);
    server.listen(port, "127.0.0.1");
  });
}
