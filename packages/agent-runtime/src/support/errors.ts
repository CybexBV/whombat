/**
 * Retryable vs. permanent provider failures. The runner retries a retryable failure once with backoff
 * (ARCHITECTURE "Agent runtime"); a permanent one fails the dispatch straight away with a quiet error.
 */

/** Failures that will not go away by trying again: credentials, billing, bad input, policy. */
const PERMANENT = [
  /\b(401|403)\b/,
  /unauthori[sz]ed|authentication|not logged in|log ?in required|invalid (api )?key|oauth/i,
  /billing|payment|credit balance|quota|usage limit|budget/i,
  /invalid[_ ]request|bad request|\b400\b|\b404\b|model[_ ]not[_ ]found|unknown model|not supported/i,
  /context (window|length)|too long|max[_ ]output[_ ]tokens|prompt is too long/i,
  /policy|refus|account on hold|verification required|org(anization)? not allowed/i,
  /\bENOENT\b|not installed|command not found|no such file/i,
];

/**
 * Classifies a free-text failure. Anything not recognisably permanent (rate limits, overload, 5xx,
 * dropped connections, crashed subprocesses, unknown errors) is retryable: the runner retries once.
 */
export function isRetryableMessage(message: string): boolean {
  return !PERMANENT.some((re) => re.test(message));
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Keeps provider error text short and single-purpose for the quiet error message. */
export function trimMessage(message: string, max = 1000): string {
  const clean = message.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
