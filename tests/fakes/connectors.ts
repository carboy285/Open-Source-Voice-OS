import type { ConnectorContext } from "../../src/connectors/types.js";
import { MemorySecretStore } from "../../src/secrets/store.js";

export type FetchCall = { url: string; init?: RequestInit };

/** fetch that answers from a handler and records requests. */
export function fakeFetch(handler: (url: string, init?: RequestInit) => unknown, status = 200) {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    const body = handler(url, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": typeof body === "string" ? "text/html" : "application/json" },
    });
  }) as typeof fetch;
  return { fn, calls };
}

export function context(
  settings: Record<string, unknown> = {},
  extra: Partial<ConnectorContext> = {},
): ConnectorContext {
  return {
    settings,
    secrets: new MemorySecretStore(),
    fetch: fakeFetch(() => ({})).fn,
    clock: { now: () => Date.parse("2026-10-18T20:00:00Z") },
    timeZone: "America/New_York",
    locale: "en-US",
    ...extra,
  };
}
