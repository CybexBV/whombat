/**
 * Whombat Feedback context sanitizing (docs/decisions/feedback.md FB-05, FB-07). Shared by the widget loader,
 * the iframe UI and the server (which re-sanitizes whatever arrives). **No imports**: the loader bundles this
 * file on its own, so it must stay free of Zod and everything else.
 */

/** The WHATWG URL parser (browsers, Node); core's lib has neither DOM nor Node types. */
interface ParsedUrl {
  protocol: string;
  username: string;
  password: string;
  host: string;
  hostname: string;
  pathname: string;
  search: string;
  hash: string;
  origin: string;
}
declare const URL: new (input: string) => ParsedUrl;

/** Hard caps on what the widget may send as context. */
export const FEEDBACK_CONTEXT_LIMITS = {
  /** Sanitized page URL (origin + path). */
  url: 1024,
  title: 160,
  /** Custom context entries (keys allowlisted per integration). */
  customEntries: 20,
  customKey: 40,
  customValue: 200,
  references: 5,
  reference: 100,
  appField: 64,
  redactPaths: 20,
  redactPath: 200,
  /** Page views in `context.trail` (CT-161): the last 10, oldest first. */
  trail: 10,
} as const;

/** Replacement for a redacted path segment. */
export const REDACTED_SEGMENT = ':id';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

/**
 * An exact website origin as an operator types it (`https://app.example.com`, `http://localhost:5173`), in its
 * canonical form (`scheme://host[:port]`, lowercase, default port dropped), or null. No wildcards, paths,
 * credentials, queries or fragments. `http:` is accepted only for loopback development hosts.
 */
export function normalizeOrigin(input: string): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 255 || raw.includes('*')) return null;
  let url: ParsedUrl;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (!url.hostname || !/^[a-z0-9.[\]:-]+$/.test(url.hostname)) return null;
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return null;
  return url.origin;
}

/** True when `origin` (already canonical, e.g. `event.origin`) is exactly one of `allowed`. */
export function originAllowed(origin: string | null | undefined, allowed: readonly string[]): boolean {
  if (!origin || origin === 'null') return false;
  const canonical = normalizeOrigin(origin);
  return canonical !== null && canonical === origin && allowed.includes(canonical);
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const LONG_NUMBER = /^\d{5,}$/;
const HEX_TOKEN = /^[0-9a-f]{16,}$/i;
const EMAIL = /@/;
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]*$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/**
 * One word of a path slug: lowercase, capitalized or CamelCase, a short all-caps word, a number of up to 4 digits,
 * or a short letters-and-digits word (`v2`, `ipv6`, `h264`, `2fa`, `4k`).
 */
const WORD =
  /^(?:[a-z]+|[A-Z]?[a-z]+(?:[A-Z][a-z]+)*|[A-Z]{1,5}|\d{1,4}|[A-Za-z]{1,4}\d{1,4}|\d{1,4}[A-Za-z]{1,3})$/;

/** Words joined by `-`, `_`, `.` or `~`: `billing-v2`, `invoices-2026`, `MyAccount`, `report_2026.pdf`. */
function isWordSlug(segment: string): boolean {
  return segment.split(/[-_.~]+/).every((part) => part === '' || WORD.test(part));
}

/** True for a path segment that looks like an identifier or secret: it is replaced by `:id`. */
export function looksLikeId(segment: string): boolean {
  if (segment.length === 0) return false;
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return true;
  }
  if (decoded.length > 64) return true;
  if (UUID.test(decoded) || LONG_NUMBER.test(decoded) || HEX_TOKEN.test(decoded) || EMAIL.test(decoded))
    return true;
  if (!SAFE_SEGMENT.test(segment)) return true;
  // Tokens (magic links, nanoids, base64url, JWT parts) rather than words: 12+ characters mixing letters and at
  // least two digits, or 16+ base64url characters with a digit or a capital, unless it's a slug of words.
  const digits = decoded.replace(/\D/g, '').length;
  const token =
    (decoded.length >= 12 && digits >= 2 && /[A-Za-z]/.test(decoded)) ||
    (decoded.length >= 16 && BASE64URL.test(decoded) && (digits > 0 || /[A-Z]/.test(decoded)));
  return token && !isWordSlug(decoded);
}

/** A redact template: `/customers/*` or `/orgs/*\/devices/*`: literal segments and `*` for “redact this one”. */
export function validRedactPath(template: string): boolean {
  if (typeof template !== 'string') return false;
  if (template.length < 2 || template.length > FEEDBACK_CONTEXT_LIMITS.redactPath) return false;
  if (!template.startsWith('/')) return false;
  const parts = template.slice(1).split('/');
  if (parts.length > 20) return false;
  return parts.every((p) => p === '*' || (p.length > 0 && /^[A-Za-z0-9._~-]+$/.test(p)));
}

function applyTemplates(segments: string[], templates: readonly string[]): string[] {
  const out = [...segments];
  for (const template of templates) {
    if (!validRedactPath(template)) continue;
    const parts = template.slice(1).split('/');
    if (parts.length > out.length) continue;
    // A template matches the start of the path; `*` segments are redacted.
    const matches = parts.every((p, i) => p === '*' || p === segments[i]);
    if (!matches) continue;
    parts.forEach((p, i) => {
      if (p === '*') out[i] = REDACTED_SEGMENT;
    });
  }
  return out;
}

/**
 * The page a report was sent from: origin + path, never the query string or fragment; id-like segments and the
 * integration's `redactPaths` templates become `:id`. Null for anything that isn't an http(s) URL.
 */
export function sanitizePageUrl(input: string, redactPaths: readonly string[] = []): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 8192) return null;
  let url: ParsedUrl;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const segments = url.pathname.split('/').slice(1);
  const redacted = applyTemplates(segments, redactPaths).map((s) =>
    s === REDACTED_SEGMENT ? s : looksLikeId(s) ? REDACTED_SEGMENT : s,
  );
  let path = `/${redacted.join('/')}`;
  if (path.length > FEEDBACK_CONTEXT_LIMITS.url - url.origin.length)
    path = `${path.slice(0, FEEDBACK_CONTEXT_LIMITS.url - url.origin.length - 1)}…`;
  return `${url.origin}${path}`;
}

/** Coarse browser and OS from a user agent: “Chrome 131 · macOS”. Never the raw user agent. */
export function coarseBrowser(userAgent: string): string {
  const ua = typeof userAgent === 'string' ? userAgent.slice(0, 512) : '';
  const version = (re: RegExp) => ua.match(re)?.[1] ?? '';
  let name = 'Other browser';
  let v = '';
  if (/Firefox\/\d/.test(ua)) {
    name = 'Firefox';
    v = version(/Firefox\/(\d+)/);
  } else if (/Edg\/\d/.test(ua)) {
    name = 'Edge';
    v = version(/Edg\/(\d+)/);
  } else if (/OPR\/\d/.test(ua)) {
    name = 'Opera';
    v = version(/OPR\/(\d+)/);
  } else if (/Chrome\/\d/.test(ua)) {
    name = 'Chrome';
    v = version(/Chrome\/(\d+)/);
  } else if (/Safari\/\d/.test(ua) && /Version\/\d/.test(ua)) {
    name = 'Safari';
    v = version(/Version\/(\d+)/);
  }
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Other OS';
  return `${name}${v ? ` ${v}` : ''} · ${os}`;
}

const CUSTOM_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;

/** True for a key an operator may allowlist for custom context. */
export function validContextKey(key: string): boolean {
  return typeof key === 'string' && CUSTOM_KEY.test(key);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Printable text only: control characters removed, trimmed, capped. */
export function cleanText(value: string, max: number): string {
  return value.replace(CONTROL, '').trim().slice(0, max);
}

/**
 * Custom context the site set with `setContext`: only allowlisted keys, scalar values (strings capped), at most
 * `FEEDBACK_CONTEXT_LIMITS.customEntries` entries. Nested objects and arrays are dropped, never flattened.
 */
export function sanitizeCustomContext(
  input: unknown,
  allowedKeys: readonly string[],
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  let n = 0;
  for (const key of Object.keys(input as object)) {
    if (n >= FEEDBACK_CONTEXT_LIMITS.customEntries) break;
    if (!validContextKey(key) || !allowedKeys.includes(key)) continue;
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string') out[key] = cleanText(value, FEEDBACK_CONTEXT_LIMITS.customValue);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean' || value === null) out[key] = value;
    else continue;
    n++;
  }
  return out;
}

/** Diagnostic references (request ids, error ids): short printable tokens only. */
export function sanitizeReferences(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const value of input) {
    if (out.length >= FEEDBACK_CONTEXT_LIMITS.references) break;
    if (typeof value !== 'string' || value.length > FEEDBACK_CONTEXT_LIMITS.reference) continue;
    const clean = cleanText(value, FEEDBACK_CONTEXT_LIMITS.reference);
    if (/^[A-Za-z0-9._:/#@-]+$/.test(clean)) out.push(clean);
  }
  return out;
}
