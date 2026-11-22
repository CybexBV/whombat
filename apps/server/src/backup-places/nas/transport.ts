/**
 * How the NAS drivers reach a NAS (docs/decisions/backup-places.md BPL-03): as its connection, server-side, never
 * through an agent's tools. Every request goes under the connection's destination policy and pinned certificate, with
 * the connection's sealed credential; nothing of it is logged.
 *
 * - TrueNAS: one JSON-RPC socket per visit, signed in as the connection's spec says (`auth.login_with_api_key`), on
 *   the connection's https address only (TrueNAS turns off a key sent over plain http).
 * - Synology: a session of the visit's own, with a SynoToken (the connection's kept session has none), signed out at
 *   the end; a refused password marks the connection as the connection's own sign-in does.
 * - QNAP: the connection's kept QTS session, as `sid` and as Container Station 3's bearer token, signed in again once
 *   when it ended.
 *
 * Calls that pull images and start containers may take minutes, so these requests carry their own deadline rather
 * than a connection call's 30 s.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { BACKUP_PLACE_TEXT, catalogEntry, placeKindOfCatalog } from '@whombat/core';
import { externalEffect } from '../../commit/scope';
import { keepBoundTarget } from '../../connections/bound-targets';
import { ConnectionChangedError } from '../../connections/call-target';
import { resolveCredential } from '../../connections/credentials';
import { openConnectionSecret } from '../../connections/crypto';
import { connectionPolicy } from '../../connections/destination';
import { connectionFetch, pinOf, renewedOn } from '../../connections/http';
import {
  rememberedOf,
  SessionError,
  sessionAccess,
  sessionAuthOf,
  sessionRefusalText,
  sessionSend,
  signInSession,
  signOutSession,
} from '../../connections/session';
import { openChannel } from '../../connections/socket/channel';
import { jsonRpcSession } from '../../connections/socket/jsonrpc';
import {
  fillLoginParams,
  type SocketLoginValues,
  type SocketSpec,
  socketHttpUrl,
} from '../../connections/socket/spec';
import { type CatalogConnectionRow, ConnectionAuthError } from '../../connections/types';
import { OutboundError, type OutboundPolicy, outboundRequest } from '../../lib/outbound';
import type { Services } from '../../services';
import { resolveHost } from '../../vault/net';
import { QnapPlaceDriver } from './qnap';
import { SynologyPlaceDriver } from './synology';
import { TrueNasCallError, TrueNasPlaceDriver, type TrueNasRpc } from './truenas';
import {
  type NasAnswer,
  type NasDriverDeps,
  type NasPlaceDriver,
  NasPlaceError,
  type NasRequest,
} from './types';

/** A request's deadline unless it says otherwise. */
const REQUEST_MS = 30_000;
/** A visit's socket: long enough to follow the jobs that pull images. */
const SOCKET_MS = 15 * 60_000;
/** One JSON-RPC call (a job answers its id at once; following it is many calls). */
const RPC_CALL_MS = 60_000;
/** Answers are read up to this much (a Synology build's output can be long; only its end matters). */
const ANSWER_MAX = 2 * 1024 * 1024;

/** A private IPv4 address (the home network): what a plain-http repository may point at. */
export function privateIpv4(address: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** The NAS's numeric LAN address: its connection's address as it is, or what its name resolves to now. */
export async function nasAddress(
  services: Services,
  row: Pick<CatalogConnectionRow, 'baseUrl' | 'label'>,
): Promise<string> {
  let host = '';
  try {
    host = new URL(row.baseUrl).hostname;
  } catch {
    host = '';
  }
  if (privateIpv4(host)) return host;
  const found = (await resolveHost(services, row.baseUrl)).find(privateIpv4);
  if (found) return found;
  throw new NasPlaceError('unreachable', `Whombat can’t find ${row.label}’s address on your network.`);
}

/** The status an http URL answers with, under the connections' destination rule; null when nothing answers. */
export function nasProbe(services: Services): (url: string) => Promise<number | null> {
  return async (url) => {
    try {
      const res = await connectionFetch(
        services,
        url,
        { method: 'GET' },
        {
          effect: 'backup-places.probe',
          idempotent: true,
          deadlineMs: 5000,
          maxBytes: 64 * 1024,
        },
      );
      return res.status;
    } catch {
      return null;
    }
  };
}

function deps(services: Services, row: CatalogConnectionRow): NasDriverDeps {
  let host: string | undefined;
  try {
    host = new URL(row.baseUrl).hostname || undefined;
  } catch {
    host = undefined;
  }
  return {
    ...(host ? { probeHost: host } : {}),
    address: () => nasAddress(services, row),
    probe: nasProbe(services),
    sleep: (ms) => sleep(ms).then(() => undefined),
    now: () => Date.now(),
  };
}

/** One request to the NAS as it is (no credential), under the connection's policy and pin. */
async function rawSend(
  services: Services,
  row: CatalogConnectionRow,
  req: NasRequest,
): Promise<NasAnswer & { url: string }> {
  const url = new URL(`${row.baseUrl.replace(/\/+$/, '')}${req.path}`);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
  const deadlineMs = req.deadlineMs ?? REQUEST_MS;
  try {
    const res = await externalEffect(
      'backup-places.nas',
      async () => {
        const policy = await connectionPolicy(services, url.toString(), {
          ...pinOf(row),
          deadlineMs,
          truncateAt: ANSWER_MAX,
        });
        return outboundRequest(
          url.toString(),
          {
            method: req.method,
            headers: { 'user-agent': 'Whombat', ...(req.headers ?? {}) },
            ...(req.body !== undefined ? { body: req.body } : {}),
          },
          policy,
        );
      },
      { idempotent: req.method === 'GET' },
    );
    return { status: res.status, body: res.body, url: url.toString() };
  } catch (err) {
    if (err instanceof OutboundError) throw new NasPlaceError('unreachable', `${row.label} didn’t answer.`);
    throw err;
  }
}

/** A connection that may change things on its NAS, else `NasPlaceError` `manage`. */
function mustManage(row: CatalogConnectionRow): void {
  if (row.access !== 'manage') throw new NasPlaceError('manage', BACKUP_PLACE_TEXT.reasons.manage);
  if (row.status === 'needs_reauth')
    throw new NasPlaceError('refused', `${row.label} needs a new password or key in Settings → Connections.`);
}

/* TrueNAS ----------------------------------------------------------------------------------------------------------- */

/** Opens one signed-in JSON-RPC socket (exported for the tests, which point it at a fake TrueNAS). */
export async function openTrueNasSocket(target: {
  baseUrl: string;
  spec: SocketSpec;
  login: SocketLoginValues;
  policy: OutboundPolicy;
}): Promise<TrueNasRpc> {
  const channel = await openChannel(socketHttpUrl(target.baseUrl, target.spec), target.policy);
  try {
    const session = jsonRpcSession(channel);
    const login = target.spec.login;
    const params = login ? fillLoginParams(login.params, target.login) : null;
    if (login && params !== null) await session.signIn(login.method, params, Date.now() + REQUEST_MS);
    return {
      async call(method, params) {
        const reply = await session.call(method, params ?? [], { deadlineAt: Date.now() + RPC_CALL_MS });
        if (!reply.ok) {
          const data = reply.error.data as Record<string, unknown> | undefined;
          throw new TrueNasCallError(
            method,
            (reply.error.code as number | string | undefined) ?? null,
            typeof data?.errname === 'string' ? data.errname : null,
          );
        }
        return reply.result;
      },
      close: () => channel.close(),
    };
  } catch (err) {
    channel.close();
    throw err;
  }
}

function trueNasOpen(services: Services, row: CatalogConnectionRow): () => Promise<TrueNasRpc> {
  return async () => {
    const spec = catalogEntry('truenas')?.socket;
    if (!spec) throw new NasPlaceError('failed', 'Whombat doesn’t know how to reach a TrueNAS.');
    try {
      const { credential } = await resolveCredential(services, row);
      if (!credential.secret) throw new ConnectionAuthError('No key.');
      const url = socketHttpUrl(row.baseUrl, spec);
      const policy = await connectionPolicy(services, url, { ...pinOf(row), deadlineMs: SOCKET_MS });
      return await externalEffect(
        'backup-places.nas',
        () =>
          openTrueNasSocket({
            baseUrl: row.baseUrl,
            spec,
            login: { secret: credential.secret as string, fields: row.fields },
            policy,
          }),
        { idempotent: true },
      );
    } catch (err) {
      // A connection that changed since the call was checked (`bound-targets.ts`) says so, not that it didn't answer.
      if (err instanceof NasPlaceError || err instanceof ConnectionChangedError) throw err;
      if (err instanceof ConnectionAuthError || (err instanceof Error && err.name === 'SocketSignInRefused'))
        throw new NasPlaceError(
          'refused',
          `${row.label} refused Whombat’s key. Replace it in Settings → Connections.`,
        );
      throw new NasPlaceError('unreachable', `${row.label} didn’t answer.`);
    }
  };
}

/* Synology ---------------------------------------------------------------------------------------------------------- */

function synologyAccess(services: Services, row: CatalogConnectionRow) {
  const entry = catalogEntry('synology');
  const auth = sessionAuthOf(row.auth);
  return {
    send: (req: NasRequest) => rawSend(services, row, req),
    async signIn(): Promise<{ sid: string; synotoken: string | null }> {
      if (!entry || !auth || !row.secretEnc)
        throw new NasPlaceError('refused', `${row.label} has no password Whombat can sign in with.`);
      // The connection's own sign-in, asking DSM for a SynoToken too; the answer is kept to read it.
      const withToken = {
        ...auth,
        login: { ...auth.login, body: { ...auth.login.body, enable_syno_token: 'yes' } },
      };
      let answer = '';
      // Signed in only as the connection the work under way was checked on (`bound-targets.ts`).
      await keepBoundTarget(services, row);
      try {
        const made = await signInSession(
          async (url, init) => {
            const res = await connectionFetch(services, url, init, {
              effect: 'backup-places.signin',
              idempotent: true,
              ...pinOf(row),
            });
            answer = res.body.toString('utf8');
            return res;
          },
          {
            entry,
            auth: withToken,
            baseUrl: row.baseUrl,
            secret: openConnectionSecret(services.custody, row.id, 'secret', row.secretEnc),
            fields: row.fields,
            now: services.clock(),
            remembered: rememberedOf(services, row),
          },
        );
        let synotoken: string | null = null;
        try {
          const t = (JSON.parse(answer) as { data?: { synotoken?: unknown } }).data?.synotoken;
          synotoken = typeof t === 'string' && t ? t : null;
        } catch {
          synotoken = null;
        }
        return { sid: made.token, synotoken };
      } catch (err) {
        if (err instanceof SessionError)
          throw new NasPlaceError('refused', sessionRefusalText(entry, err, auth));
        if (err instanceof OutboundError)
          throw new NasPlaceError('unreachable', `${row.label} didn’t answer.`);
        throw err;
      }
    },
    async signOut(sid: string): Promise<void> {
      if (auth)
        await signOutSession(sessionSend(services, row, 'backup-places.signout'), {
          auth,
          baseUrl: row.baseUrl,
          token: sid,
        });
    },
  };
}

/* QNAP -------------------------------------------------------------------------------------------------------------- */

function qnapAccess(services: Services, row: CatalogConnectionRow) {
  return {
    async send(req: NasRequest): Promise<NasAnswer> {
      for (let attempt = 0; ; attempt++) {
        let sid: string;
        try {
          sid = (await sessionAccess(services, row, { force: attempt > 0 })).token;
        } catch (err) {
          if (err instanceof ConnectionAuthError)
            throw new NasPlaceError(
              'refused',
              `${row.label} needs a new password in Settings → Connections.`,
            );
          throw new NasPlaceError('unreachable', `${row.label} didn’t answer.`);
        }
        // Sent only as the connection the work under way was checked on (`bound-targets.ts`).
        await keepBoundTarget(services, row);
        const res = await rawSend(services, row, {
          ...req,
          query: { ...(req.query ?? {}), ...(req.path.startsWith('/cgi-bin/') ? { sid } : {}) },
          headers: { ...(req.headers ?? {}), Authorization: `Bearer ${sid}` },
        });
        // A 401/403 or an answer that says the session ended (File Station's status 3): once more, signed in again.
        const ended = renewedOn(row, res.status, { body: res.body, url: res.url });
        if (!ended || attempt > 0) return { status: res.status, body: res.body };
      }
    },
  };
}

/* The driver of a NAS connection ------------------------------------------------------------------------------------- */

/**
 * The driver of a Synology, TrueNAS or QNAP connection. Throws `NasPlaceError` `manage` for a connection that only
 * looks, and an Error for a connection that isn't one of the three.
 */
export function nasPlaceDriver(services: Services, row: CatalogConnectionRow): NasPlaceDriver {
  const kind = placeKindOfCatalog(row.catalogId);
  if (!kind) throw new Error(`${row.catalogId} can’t keep backups.`);
  mustManage(row);
  const d = deps(services, row);
  switch (kind) {
    case 'truenas':
      return new TrueNasPlaceDriver(trueNasOpen(services, row), d, row.label);
    case 'synology':
      return new SynologyPlaceDriver(synologyAccess(services, row), d, row.label);
    case 'qnap':
      return new QnapPlaceDriver(qnapAccess(services, row), d, row.label);
    default:
      throw new Error(`${row.catalogId} can’t keep backups.`);
  }
}

/** A TrueNAS's apps pool, or null (a read: what a compose pasted by hand names; any access will do). */
export async function trueNasAppsPool(services: Services, row: CatalogConnectionRow): Promise<string | null> {
  if (row.catalogId !== 'truenas' || row.status !== 'active') return null;
  return new TrueNasPlaceDriver(trueNasOpen(services, row), deps(services, row), row.label)
    .appsPool()
    .catch(() => null);
}
