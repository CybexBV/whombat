/**
 * Calls Whombat itself makes with a secret, safe by construction (docs/decisions/vault.md VT-41…VT-43; since 0.125 a
 * Vault entry's Check connection and the connections' requests, the relayed `vault_request` gone, CT-1242): queries,
 * the credential added last, response headers filtered, and every form of the secret scrubbed from whatever goes back.
 * Pure: no `URL`, `Buffer` or `btoa`.
 */

import { type ParsedVaultUrl, parseVaultUrl, vaultPathProblem } from './network.js';
import type { VaultAuth } from './schemas.js';
import { VAULT_CALL_DEADLINE_MS } from './schemas.js';

/* Paths and queries (VT-41) --------------------------------------------------------------------- */

export type VaultQuery = Readonly<Record<string, string | readonly string[]>>;

/** RFC 3986 percent-encoding of a query component (spaces as `%20`). */
function encodeQueryPart(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The query string of a request (`?a=1&b=2`, or `''`), without the credential. Refused when it sets the parameter an
 * entry signing in with `query` puts its secret in (compared without case).
 */
export function vaultRequestQuery(
  query: VaultQuery | undefined,
  auth: VaultAuth | null,
): { ok: true; search: string } | { ok: false; message: string } {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(query ?? {})) {
    if (auth?.type === 'query' && name.toLowerCase() === auth.name.toLowerCase())
      return { ok: false, message: `The query can’t set ${name}: Whombat adds it.` };
    for (const v of typeof value === 'string' ? [value] : value)
      parts.push(`${encodeQueryPart(name)}=${encodeQueryPart(v)}`);
  }
  return { ok: true, search: parts.length ? `?${parts.join('&')}` : '' };
}

/* Headers ---------------------------------------------------------------------------------------------------------- */

/** Canonical capitalisation (`content-type` → `Content-Type`, `etag` → `ETag`, `x-ratelimit-…` → `X-RateLimit-…`). */
function headerCase(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'etag') return 'ETag';
  const words = lower.split('-').map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w));
  if (words[0] === 'X' && words[1] === 'Ratelimit') words[1] = 'RateLimit';
  return words.join('-');
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
const HEADER_VALUE_BAD = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/* Credentials ----------------------------------------------------------------------------------- */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** UTF-8 bytes of a string (lone surrogates as U+FFFD). */
function utf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    let c = ch.codePointAt(0) as number;
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** Standard base64 (with padding) of a string's UTF-8. */
export function vaultBase64(text: string): string {
  const bytes = utf8(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += b === undefined ? '=' : B64[(n >> 6) & 63];
    out += c === undefined ? '=' : B64[n & 63];
  }
  return out;
}

/** `Basic <base64(username:password)>`. */
export function vaultBasicAuthorization(username: string, password: string): string {
  return `Basic ${vaultBase64(`${username}:${password}`)}`;
}

/**
 * What the server adds to a request for an entry, last: a header (`bearer`, `header`, `basic`) or a query parameter
 * (`query`, appended after the request's own query). Nothing for `none`. A `form` login (VT-D28) is only ever filled into a
 * sign-in page by Hermes's credential vault, and an `ssh_key` only signs in over SSH (VT-S01), never sent with a
 * request: asking for either's credential throws.
 */
export function vaultCredential(
  auth: VaultAuth,
  secret: string,
): { headers: Record<string, string>; query: string | null } {
  switch (auth.type) {
    case 'bearer':
      return { headers: { Authorization: `Bearer ${secret}` }, query: null };
    case 'header':
      return { headers: { [auth.name]: secret }, query: null };
    case 'basic':
      return { headers: { Authorization: vaultBasicAuthorization(auth.username, secret) }, query: null };
    case 'query':
      return { headers: {}, query: `${encodeQueryPart(auth.name)}=${encodeQueryPart(secret)}` };
    case 'none':
      return { headers: {}, query: null };
    case 'form':
      throw new Error('A website login is only filled into its sign-in page, never sent with a request.');
    case 'ssh_key':
      throw new Error('An SSH key only signs in to its servers over SSH, never sent with a request.');
  }
}

/** Appends the credential's query parameter to a request URL. */
export function withCredentialQuery(url: string, query: string | null): string {
  if (!query) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

/**
 * Why a secret can't be used with how an entry signs in, or null: one that travels in a header can't hold line
 * breaks or control characters (a `query` secret is encoded); neither can a
 * website password (`form`), which a password input would never take.
 */
export function vaultSecretProblem(auth: Pick<VaultAuth, 'type'> | null, value: string): string | null {
  if (auth && ['bearer', 'header', 'basic'].includes(auth.type) && HEADER_VALUE_BAD.test(value))
    return 'This secret travels in a header, so it can’t hold line breaks or control characters.';
  if (auth?.type === 'form' && HEADER_VALUE_BAD.test(value))
    return 'A password can’t hold line breaks or control characters.';
  return null;
}

/* Responses (VT-41) ----------------------------------------------------------------------------- */

/** Response headers an agent sees (lowercase), plus `x-ratelimit-*` and a filtered `location`. */
export const VAULT_RESPONSE_HEADERS: readonly string[] = [
  'content-type',
  'content-length',
  'etag',
  'last-modified',
  'retry-after',
  'link',
];

/** What `Location` reads as when it points outside the entry's base. */
export const VAULT_LOCATION_ELSEWHERE = 'elsewhere';

/**
 * Whether a `Location` stays under the entry's base: an absolute URL with the same origin, or an absolute path, whose
 * path is the base path or below it. Relative references resolve against `requestPath`'s directory.
 */
function locationUnderBase(location: string, base: ParsedVaultUrl, requestPath?: string): boolean {
  let path: string;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(location)) {
    const parsed = parseVaultUrl(location.replace(/[?#].*$/, ''));
    if (!parsed.ok || parsed.url.origin !== base.origin) return false;
    path = parsed.url.path;
  } else if (location.startsWith('//')) {
    return false;
  } else if (location.startsWith('/')) {
    path = location.replace(/[?#].*$/, '');
  } else {
    if (!requestPath) return false;
    const dir = requestPath.replace(/[^/]*$/, '');
    path = `${dir}${location.replace(/[?#].*$/, '')}`;
  }
  if (vaultPathProblem(path)) return false;
  return base.basePath === '' || path === base.basePath || path.startsWith(`${base.basePath}/`);
}

/**
 * The response headers an agent may see: `Content-Type`, `Content-Length`, `ETag`, `Last-Modified`, `Retry-After`,
 * `Link`, `X-RateLimit-*`, and `Location` only when it points under the same base (else `"elsewhere"`). Header values
 * are joined with `, ` when repeated. Scrub the result before it leaves the server.
 */
export function filterVaultResponseHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  base: ParsedVaultUrl | string,
  requestPath?: string,
): Record<string, string> {
  const entry = typeof base === 'string' ? parseVaultUrl(base) : ({ ok: true, url: base } as const);
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(headers)) {
    if (raw === undefined) continue;
    const value = typeof raw === 'string' ? raw : raw.join(', ');
    const lower = name.toLowerCase();
    if (VAULT_RESPONSE_HEADERS.includes(lower) || lower.startsWith('x-ratelimit-')) {
      out[headerCase(lower)] = value;
    } else if (lower === 'location') {
      out.Location =
        entry.ok && locationUnderBase(value.trim(), entry.url, requestPath)
          ? value
          : VAULT_LOCATION_ELSEWHERE;
    }
  }
  return out;
}

/* Scrubbing (VT-42) ----------------------------------------------------------------------------- */

/** What a secret is replaced with. */
export const VAULT_SCRUBBED = '[secret]';

/**
 * Every form of a secret a remote side might echo: the value, its URL encodings (upper- and lowercase escapes, `+` for
 * spaces), its JSON-escaped form, standard and URL-safe base64 (with and without padding), and for a login the
 * `username:password` base64. Longest first.
 */
export function vaultSecretForms(secret: string, username?: string | null): string[] {
  const forms = new Set<string>();
  const add = (s: string) => {
    if (s) forms.add(s);
  };
  add(secret);
  const encoded = encodeQueryPart(secret);
  add(encoded);
  add(encoded.replace(/%[0-9A-F]{2}/g, (e) => e.toLowerCase()));
  add(encoded.replace(/%20/g, '+'));
  add(encodeURIComponent(secret));
  add(JSON.stringify(secret).slice(1, -1));
  const b64 = (text: string) => {
    const std = vaultBase64(text);
    add(std);
    add(std.replace(/=+$/, ''));
    const url = std.replace(/\+/g, '-').replace(/\//g, '_');
    add(url);
    add(url.replace(/=+$/, ''));
  };
  b64(secret);
  if (username) b64(`${username}:${secret}`);
  return [...forms].sort((a, b) => b.length - a.length);
}

/**
 * Replaces every occurrence of the secret, and of each of its encoded forms (`vaultSecretForms`), with `[secret]`.
 * Apply to results, headers and error text before anything reaches an agent, a log or an event.
 */
export function scrubSecret(text: string, secret: string, username?: string | null): string {
  if (!secret) return text;
  let out = text;
  for (const form of vaultSecretForms(secret, username)) out = out.split(form).join(VAULT_SCRUBBED);
  return out;
}

/** `scrubSecret` over every string in a JSON value (keys too). */
export function scrubSecretDeep<T>(value: T, secret: string, username?: string | null): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrubSecret(v, secret, username);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[scrubSecret(k, secret, username)] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/* Failures (VT-42) ------------------------------------------------------------------------------ */

/** Why a call didn't give the agent an answer. The remote side's words are never quoted. */
export const VAULT_FAILURES = [
  'timeout',
  'unreachable',
  'too_large',
  'not_allowed',
  'busy',
  'invalid_request',
  /** 0.32.0, SSH (VT-S04…VT-S08): no server by that name on the entry. */
  'no_server',
  /** The server's host key isn't trusted yet (VT-S05). */
  'host_key_unconfirmed',
  /** The server showed another host key than the trusted one (VT-S05). */
  'host_key_changed',
  /** The server refused the key. */
  'rejected',
] as const;
export type VaultFailure = (typeof VAULT_FAILURES)[number];

export const VAULT_FAILURE_TEXT: Record<VaultFailure, string> = {
  timeout: `It didn’t answer within ${VAULT_CALL_DEADLINE_MS / 1000} seconds.`,
  unreachable: 'Couldn’t reach it.',
  too_large: 'Its answer was too large.',
  not_allowed: 'This Vault entry’s address isn’t allowed any more.',
  busy: 'Too many calls to this entry at once. Try again in a moment.',
  invalid_request: 'That request can’t be sent.',
  no_server: 'That Vault entry has no server by that name.',
  host_key_unconfirmed: 'Nobody has confirmed this server’s host key in the Vault yet.',
  host_key_changed:
    'This server’s host key changed, so Whombat didn’t connect. It has to be checked in the Vault first.',
  rejected: 'The server refused the key.',
};

/**
 * The `no_server` answer of an SSH tool (VT-G04, 0.33.0), naming the servers the agent's key covers so it can pick the
 * right one or tell the person to add it: “That Vault entry has no server by that name. Its servers: web-1, nas.” Names
 * only, in every turn (a target is never in a tool answer). Without any: “… It has no servers your key covers yet.”
 *
 * `canAdd` (0.112.0, CT-785; Whombat vault-self-serve.md VS-12): the agent in the person's turn, which adds the
 * host itself: “That host isn’t one of this key’s servers yet: add it with vault_add_server, or use one of: web-1, nas.”
 */
export function vaultNoServerText(
  serverNames: readonly string[],
  options: { canAdd?: boolean } = {},
): string {
  if (options.canAdd)
    return `That host isn’t one of this key’s servers yet: add it with vault_add_server${
      serverNames.length ? `, or use one of: ${serverNames.join(', ')}` : ''
    }.`;
  return serverNames.length
    ? `${VAULT_FAILURE_TEXT.no_server} Its servers: ${serverNames.join(', ')}.`
    : `${VAULT_FAILURE_TEXT.no_server} It has no servers your key covers yet.`;
}

/** “The server answered 401.” */
export function vaultStatusText(status: number): string {
  return `The server answered ${status}.`;
}
