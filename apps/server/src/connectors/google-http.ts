/**
 * Talking to Google over plain `fetch` (docs/decisions/connectors.md CN-05, CN-06): every request goes to a
 * fixed Google host (`GOOGLE_HOSTS`) with a timeout, and Google's error bodies become `GoogleApiError`s that
 * keep the activation link of a turned-off API (`SERVICE_DISABLED` / `accessNotConfigured`).
 */
import { GoogleApiError, isGoogleUrl } from './types';

/** The `fetch` the adapters use (tests pass a mock). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** How long one Google call may take. */
export const GOOGLE_TIMEOUT_MS = 15_000;

/** `fetch` to a Google host only: anything else throws before a byte leaves the server. */
export async function googleFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!isGoogleUrl(url)) throw new Error(`Refusing to call a host that isn’t Google’s: ${safeHost(url)}`);
  return fetchImpl(url, {
    ...init,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'not a URL';
  }
}

/** Reads a response body as JSON, or null when it is not JSON. */
export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Where a turned-off API is turned on: Google's own console pages only (the link is shown to people). */
const CONSOLE_HOSTS = ['console.developers.google.com', 'console.cloud.google.com'];

/** An https link on Google's console, or null. */
export function consoleLink(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 2048) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && CONSOLE_HOSTS.includes(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

interface GoogleErrorBody {
  /** An API error object, or an OAuth-style `error` code with `error_description`. */
  error?:
    | string
    | {
        code?: number;
        message?: string;
        status?: string;
        errors?: { reason?: string; message?: string }[];
        details?: {
          '@type'?: string;
          reason?: string;
          metadata?: Record<string, string>;
          links?: { description?: string; url?: string }[];
        }[];
      };
  error_description?: string;
}

const DISABLED_REASONS = new Set(['SERVICE_DISABLED', 'accessNotConfigured']);
const SCOPE_REASONS = new Set([
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'insufficientPermissions',
  'insufficientScopes',
]);
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED']);

/**
 * A Google API error from its status and JSON body. A 403 `SERVICE_DISABLED` / `accessNotConfigured` gives
 * `reason: 'api_disabled'` and the activation link (the ErrorInfo's `activationUrl`, else the Help link,
 * else the link in the message); a missing scope gives `no_scope`. The one mapping for the service checks
 * and the Workspace adapter.
 */
export function googleApiError(status: number, body: unknown): GoogleApiError {
  const b = body as GoogleErrorBody | null;
  const err = typeof b?.error === 'object' ? b.error : undefined;
  const oauth = typeof b?.error === 'string' ? (b.error_description ?? b.error) : null;
  const message = (
    typeof err?.message === 'string' ? err.message : (oauth ?? `Google answered ${status}.`)
  ).slice(0, 500);
  const reasons = new Set<string>();
  for (const e of err?.errors ?? []) if (typeof e.reason === 'string') reasons.add(e.reason);
  let enableUrl: string | null = null;
  for (const d of err?.details ?? []) {
    if (typeof d.reason === 'string') reasons.add(d.reason);
    enableUrl ??= consoleLink(d.metadata?.activationUrl);
    for (const link of d.links ?? []) enableUrl ??= consoleLink(link.url);
  }
  const disabled =
    [...reasons].some((r) => DISABLED_REASONS.has(r)) ||
    /has not been used in project|it is disabled/i.test(message);
  if (disabled) {
    enableUrl ??= consoleLink(
      /https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"'<>]+/.exec(message)?.[0],
    );
    return new GoogleApiError(status, message, 'api_disabled', enableUrl);
  }
  const scopeDenied = err?.status === 'PERMISSION_DENIED' && /scope/i.test(message);
  if ([...reasons].some((r) => SCOPE_REASONS.has(r)) || scopeDenied)
    return new GoogleApiError(status, message, 'no_scope');
  if (status === 401) return new GoogleApiError(status, message, 'unauthorized');
  if (status === 404) return new GoogleApiError(status, message, 'not_found');
  if (status === 429 || [...reasons].some((r) => RATE_REASONS.has(r)))
    return new GoogleApiError(status, message, 'rate_limited');
  return new GoogleApiError(status, message, 'other');
}
