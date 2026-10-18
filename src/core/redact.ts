/** Replaces anything that looks like an API key or bearer token with "[redacted]". */
export function redactSecrets(text: string): string {
  return text
    .replace(/(bearer\s+)[\w.~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/\b(?:sk|pk|rk|nvapi|xox[abpr]|ghp|gho|ghs|github_pat|AIza)[-_A-Za-z0-9]{8,}/g, "[redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]");
}

/** An error's message plus its cause (fetch puts the network reason there), with secrets removed. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return redactSecrets(String(error));
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return redactSecrets(cause && !error.message.includes(cause) ? `${error.message} (${cause})` : error.message);
}
