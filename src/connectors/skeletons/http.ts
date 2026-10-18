import { accessToken } from "../oauth.js";
import type { ConnectorContext } from "../types.js";

/** Calls an official API with the stored OAuth token. */
export async function apiJson(
  ctx: ConnectorContext,
  connector: { id: string; name: string },
  url: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Record<string, unknown>> {
  const token = await accessToken(ctx.secrets, connector.id, undefined, ctx.fetch, ctx.clock.now());
  if (!token) throw new Error(`Connect ${connector.name} in Settings › Connectors first.`);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  let body = init.body;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await ctx.fetch(url, { ...init, headers, body });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || json.ok === false) {
    const reason =
      (json.error as { message?: string } | undefined)?.message ?? json.error ?? json.message ?? res.status;
    throw new Error(`${connector.name} request failed: ${String(reason)}`);
  }
  return json;
}

export const GOOGLE_AUTH = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  extraParams: { access_type: "offline", prompt: "consent" },
};

export const clientIdSetting = { key: "clientId", label: "OAuth client ID (your own)", type: "text" as const };

/** RFC 2822 message, base64url-encoded, as the Gmail API expects. */
export function rawEmail(to: string[], subject: string, body: string, cc: string[] = []): string {
  const encodedSubject = /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const lines = [
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}
