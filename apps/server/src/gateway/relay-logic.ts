/**
 * The AI gateway relay, the pure part (docs/decisions/ai-gateway.md AIG-09): which headers go on to the gateway and
 * back to the CLI, where a request goes, and the error bodies the CLIs understand (Anthropic's for Claude Code,
 * OpenAI's for Codex). No I/O.
 */
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import type { GatewayProvider } from '@whombat/core';

/** Hop-by-hop headers (RFC 9110 §7.6.1) and what Node sets itself: never relayed either way. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/** The caller's credential (the turn's agent token) and where the request came from: never sent to the gateway. */
const CALLER_ONLY = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
]);

/** The names a `Connection` header lists (also hop-by-hop). */
function connectionListed(headers: IncomingHttpHeaders): Set<string> {
  const raw = headers.connection;
  const text = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
  return new Set(
    text
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * The request's headers as the gateway gets them (AIG-09): without the caller's `authorization` / `x-api-key` (the
 * agent token), hop-by-hop headers, forwarding headers and any `x-fusebox-*` (Fusebox's own routing and identity
 * headers are Fusebox's to set), and with `Authorization: Bearer <client key>` — none for an open Fusebox.
 */
export function relayRequestHeaders(
  incoming: IncomingHttpHeaders,
  clientKey: string | null,
): OutgoingHttpHeaders {
  const listed = connectionListed(incoming);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    const n = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(n) || CALLER_ONLY.has(n) || listed.has(n)) continue;
    if (n.startsWith('x-fusebox-') || n.startsWith('x-cliproxy-')) continue;
    out[n] = value;
  }
  if (clientKey) out.authorization = `Bearer ${clientKey}`;
  return out;
}

/**
 * The gateway's response headers as the CLI gets them: without hop-by-hop headers (Node frames the body itself) and
 * without Fusebox's own `x-fusebox-*` (the account that answered is Whombat's to record, AIG-09).
 */
export function relayResponseHeaders(incoming: IncomingHttpHeaders): OutgoingHttpHeaders {
  const listed = connectionListed(incoming);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    const n = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(n) || listed.has(n) || n.startsWith('x-fusebox-')) continue;
    out[n] = value;
  }
  return out;
}

/**
 * The account that answered (`x-fusebox-account`), bounded; null when the gateway doesn't say. Node reads header bytes
 * as Latin-1, and Fusebox writes UTF-8 (its masked key labels have “…”), so the bytes are read again as UTF-8 when they
 * are valid UTF-8.
 */
export function answeringAccount(headers: IncomingHttpHeaders): string | null {
  const raw = headers['x-fusebox-account'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value) return null;
  const utf8 = Buffer.from(value, 'latin1').toString('utf8');
  return (utf8.includes('\uFFFD') ? value : utf8).slice(0, 200);
}

/**
 * Where a relayed request goes: the gateway's base with the path below the provider's relay base and the query as
 * sent (`/ai-gateway/codex/v1/responses?x=1` → `<base>/v1/responses?x=1`).
 */
export function upstreamUrl(baseUrl: string, path: string, search: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const rest = path.replace(/^\/+/, '');
  return `${base}/${rest}${search}`;
}

/**
 * An error as the provider's API words it, so the CLI shows it (AIG-09): Anthropic's `{type: 'error', error: {type,
 * message}}` for Claude Code, OpenAI's `{error: {message, type, code, param}}` for Codex.
 */
export function relayErrorBody(provider: GatewayProvider, status: number, message: string): unknown {
  if (provider === 'claude') {
    const type =
      status === 401
        ? 'authentication_error'
        : status === 403
          ? 'permission_error'
          : status === 404
            ? 'not_found_error'
            : status === 413
              ? 'request_too_large'
              : status >= 500
                ? 'api_error'
                : 'invalid_request_error';
    return { type: 'error', error: { type, message } };
  }
  const type =
    status === 401
      ? 'invalid_request_error'
      : status === 404
        ? 'invalid_request_error'
        : status >= 500
          ? 'server_error'
          : 'invalid_request_error';
  const code =
    status === 401
      ? 'invalid_api_key'
      : status === 403
        ? 'forbidden'
        : status === 404
          ? 'not_found'
          : status === 409
            ? 'conflict'
            : status === 413
              ? 'request_too_large'
              : status >= 500
                ? 'bad_gateway'
                : null;
  return { error: { message, type, code, param: null } };
}

/** The relay's request body cap (AIG-09). */
export const RELAY_BODY_MAX = 64 * 1024 * 1024;
/** No byte either way for this long ends a relayed request (AIG-09; no total deadline). */
export const RELAY_IDLE_MS = 10 * 60_000;
