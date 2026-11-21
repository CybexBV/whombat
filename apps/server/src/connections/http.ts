/**
 * Outbound HTTP of catalog connections (docs/decisions/connections-catalog.md CX-32, CX-33, CX-36, CX-40). Every
 * request goes through `lib/outbound.ts` under the connection destination policy (`connectionPolicy`: public https, or
 * the home-network list with its ports; DNS pinned; no redirects; a total deadline; capped bodies).
 *
 * - `connectionFetch`: the connect side's unsigned requests (checks, MCP and OAuth discovery, token exchanges,
 *   Nextcloud's login flow), each an external effect.
 * - `signedConnectionFetch`: a request as the connection (tools, the pooled MCP client), signed in last with the
 *   connection's credential (`credentials.ts`) and retried once with a forced refresh when an OAuth connection's token
 *   is refused (401), or a session's (a 401, 403 or an answer that says the session ended, NS-03). An answer that holds a form of the credential is withheld whole (VT-D22). Errors are summarised
 *   (`VaultCallError`), never quoted.
 */
import { CONNECTION_CALL_DEADLINE_MS, sessionIsStale } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { externalEffect } from '../commit/scope';
import { catalogConnections } from '../db/schema/index';
import {
  OutboundError,
  type OutboundInit,
  type OutboundResponse,
  outboundDatagram,
  outboundRequest,
  presentedCertSha256,
} from '../lib/outbound';
import { OutboundLineError, outboundLine } from '../lib/outbound-line';
import type { Services } from '../services';
import { summarise, VaultCallError, VaultEchoError, type VaultFetchOptions } from '../vault/net';
import { bytesHoldSecret, type SecretForms } from '../vault/scrub';
import { resolveCredential } from './credentials';
import { connectionPolicy } from './destination';
import { ConnectionOutcomeUnknownError } from './request';
import { sessionAuthOf } from './session';
import type { CatalogConnectionRow } from './types';

export interface ConnectionFetchOptions {
  /** Default 15 s (checks, discovery and token calls are small). */
  deadlineMs?: number;
  maxBytes?: number;
  /** The effect's label (`connections.check`, `connections.token` …). */
  effect?: string;
  /** Repeating it is harmless (a read, a probe): it doesn't pin a session command (CS-01). Default true. */
  idempotent?: boolean;
  /** A self-signed home-network certificate's SHA-256 fingerprint (Proxmox, CX-60), from the connection's fields. */
  pinnedCertSha256?: string;
}

const DEFAULT_DEADLINE_MS = 15_000;

/** One unsigned request under the connection destination policy for `url`. Throws `OutboundError`. */
export async function connectionFetch(
  services: Services,
  url: string,
  init: OutboundInit,
  options: ConnectionFetchOptions = {},
): Promise<OutboundResponse> {
  const deadlineMs = Math.min(options.deadlineMs ?? DEFAULT_DEADLINE_MS, CONNECTION_CALL_DEADLINE_MS);
  return externalEffect(
    options.effect ?? 'connections.request',
    async () => {
      const policy = await connectionPolicy(services, url, {
        ...(options.pinnedCertSha256 ? { pinnedCertSha256: options.pinnedCertSha256 } : {}),
      });
      return outboundRequest(
        url,
        { ...init, headers: { 'user-agent': 'Whombat', ...(init.headers ?? {}) } },
        {
          ...policy,
          deadlineMs: Math.min(policy.deadlineMs ?? deadlineMs, deadlineMs),
          timeoutMs: Math.min(policy.timeoutMs ?? deadlineMs, deadlineMs),
          maxBytes: options.maxBytes ?? 512 * 1024,
        },
      );
    },
    { idempotent: options.idempotent ?? true },
  );
}

/**
 * The SHA-256 fingerprint the home-network https server at `url` presents, under the connection destination policy
 * (a handshake only, CX-D33), or null when it isn't one or can't be read.
 */
export async function connectionCertificate(services: Services, url: string): Promise<string | null> {
  try {
    return await externalEffect(
      'connections.certificate',
      async () => {
        const policy = await connectionPolicy(services, url);
        return presentedCertSha256(url, { ...policy, deadlineMs: DEFAULT_DEADLINE_MS });
      },
      { idempotent: true },
    );
  } catch {
    return null;
  }
}

/**
 * One UDP datagram to `port` on the connection's host under its destination policy, and the first answer (a console's
 * discovery, `outboundDatagram`), or null when none came in time. A refused destination throws `OutboundError`.
 */
export async function connectionDatagram(
  services: Services,
  row: Pick<CatalogConnectionRow, 'baseUrl'>,
  port: number,
  payload: Buffer,
  timeoutMs = 1_500,
): Promise<Buffer | null> {
  const url = new URL(row.baseUrl);
  url.protocol = url.protocol === 'https:' ? 'https:' : 'http:';
  url.port = String(port);
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return externalEffect(
    'connections.datagram',
    async () => {
      const policy = await connectionPolicy(services, url.toString());
      return outboundDatagram(url.toString(), payload, { ...policy, timeoutMs, deadlineMs: timeoutMs });
    },
    { idempotent: true },
  );
}

/** One TCP line, always to the connection's own host and an explicitly allowed port. */
export async function connectionLine(
  services: Services,
  row: Pick<CatalogConnectionRow, 'baseUrl'>,
  port: number,
  command: string,
  idempotent: boolean,
): Promise<string> {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new OutboundError('bad_url', 'A TCP command needs a port.');
  const url = new URL(row.baseUrl);
  url.protocol = 'http:';
  url.port = String(port);
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return externalEffect(
    'connections.line',
    async () => {
      try {
        const policy = await connectionPolicy(services, url.toString());
        return await outboundLine(url.toString(), command, { ...policy, timeoutMs: 3000, deadlineMs: 3000 });
      } catch (error) {
        if (!idempotent && error instanceof OutboundLineError && error.sent)
          throw new ConnectionOutcomeUnknownError(
            'The PS5 may have received the reboot request, but its answer was lost. Check the console before trying again.',
          );
        throw summarise(error);
      }
    },
    { idempotent },
  );
}

/** The body as JSON, or null. */
export function jsonOf(res: Pick<OutboundResponse, 'body'>): unknown {
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    return null;
  }
}

/** An outbound failure in our own words (never what the other side said). */
export function outboundText(err: unknown): string {
  if (err instanceof OutboundError) {
    switch (err.reason) {
      case 'timeout':
        return 'It didn’t answer in time.';
      case 'destination':
      case 'private_address':
      case 'host_not_allowed':
      case 'scheme':
        return 'That address isn’t allowed.';
      case 'certificate':
        return 'Its certificate isn’t the one pinned for this connection.';
      case 'untrusted_certificate':
        return 'Its certificate can’t be verified: it’s self-signed, expired or for another name.';
      case 'too_large':
        return 'It answered with too much.';
      case 'bad_url':
        return 'That isn’t an address Whombat can use.';
      default:
        return 'Whombat couldn’t reach it.';
    }
  }
  return 'Whombat couldn’t reach it.';
}

/** `application/x-www-form-urlencoded` of the defined values. */
export function formBody(values: Record<string, string | undefined | null>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== null) out.set(k, v);
  return out.toString();
}

/** What an agent hears when an answer echoed the connection's token (VT-D22). */
export const CONNECTION_WITHHELD_TEXT =
  'The answer contained this connection’s token, so Whombat held it back.';

/** Sign-ins whose token is renewed by Whombat: a 401 is tried once more with a fresh one (CX-D19, CS-12). */
const RENEWED_KINDS = new Set(['ha_oauth', 'mcp_oauth', 'app_oauth', 'client_credentials']);

/**
 * Whether an answer is tried once more with a fresh credential: a 401 for the kinds Whombat renews, a 401 or 403 for a
 * session (Pi-hole answers an expired session 401, Nginx Proxy Manager an expired token 403; CM-11), and a 2xx answer
 * a session's `stale` rules read as the session ended (Synology's `error.code` 106, QNAP's `authPassed` 0; NS-03),
 * for the call to `url`.
 */
export function renewedOn(
  row: Pick<CatalogConnectionRow, 'signIn' | 'auth'>,
  status: number,
  answer?: { body: Buffer; url: string },
): boolean {
  const session = sessionAuthOf(row.auth);
  if (session) {
    if (status === 401 || status === 403) return true;
    if (!answer || !session.stale?.length) return false;
    let path = '';
    try {
      path = new URL(answer.url).pathname;
    } catch {
      // A URL that doesn't parse was never sent.
    }
    return sessionIsStale(session, status, answer.body.toString('utf8'), path);
  }
  return status === 401 && RENEWED_KINDS.has(row.signIn);
}

export interface ConnectionRequest {
  method: string;
  /** The full URL without the credential (a `query` sign-in's parameter is added here). */
  url: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

/** The agent's (or adapter's) headers with the credential last: nothing before it can set or shadow it. */
export function signedHeaders(
  headers: Readonly<Record<string, string>>,
  credential: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = { 'User-Agent': 'Whombat' };
  const names = new Set(Object.keys(credential).map((n) => n.toLowerCase()));
  const put = (name: string, value: string) => {
    for (const k of Object.keys(out)) if (k.toLowerCase() === name.toLowerCase()) delete out[k];
    out[name] = value;
  };
  for (const [name, value] of Object.entries(headers)) if (!names.has(name.toLowerCase())) put(name, value);
  for (const [name, value] of Object.entries(credential)) put(name, value);
  return out;
}

function withQuery(url: string, query: Readonly<Record<string, string>>): string {
  const entries = Object.entries(query);
  if (!entries.length) return url;
  const u = new URL(url);
  for (const [k, v] of entries) u.searchParams.set(k, v);
  return u.toString();
}

/** The connection as it is now (a refresh may have changed its access token since it was read). */
export async function currentRow(
  services: Services,
  connectionId: string,
): Promise<CatalogConnectionRow | null> {
  const [row] = await services.db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.id, connectionId));
  return row ?? null;
}

/**
 * Sends one request as the connection. `onForms` hears the credential's secret forms (the pool's echo check). Throws
 * `VaultCallError` (summarised), `VaultEchoError` when the answer holds the credential, or `ConnectionAuthError`.
 */
export async function signedConnectionFetch(
  services: Services,
  row: CatalogConnectionRow,
  req: ConnectionRequest,
  options: VaultFetchOptions & { onForms?: (forms: SecretForms[]) => void } = {},
): Promise<OutboundResponse> {
  const send = async (force: boolean) => {
    const { credential, forms } = await resolveCredential(services, row, { forceRefresh: force });
    options.onForms?.(forms);
    const policy = await connectionPolicy(services, req.url, { ...options, ...pinOf(row) });
    try {
      const res = await outboundRequest(
        withQuery(req.url, credential.query),
        {
          method: req.method,
          headers: signedHeaders(req.headers ?? {}, credential.headers),
          ...(req.body !== undefined ? { body: req.body } : {}),
        },
        policy,
      );
      return { res, forms };
    } catch (err) {
      if (err instanceof OutboundError || err instanceof VaultCallError) throw summarise(err);
      throw err;
    }
  };
  let { res, forms } = await send(false);
  if (renewedOn(row, res.status, { body: res.body, url: req.url })) ({ res, forms } = await send(true));
  if (bytesHoldSecret(res.body, forms)) throw new VaultEchoError(res.status);
  return res;
}

/** The connection's pinned certificate (the catalog's `fingerprint` field, Proxmox CX-60), as `connectionPolicy` takes it. */
export function pinOf(row: Pick<CatalogConnectionRow, 'fields'>): { pinnedCertSha256?: string } {
  const pin = row.fields?.fingerprint;
  return typeof pin === 'string' && pin.trim() ? { pinnedCertSha256: pin.trim() } : {};
}
