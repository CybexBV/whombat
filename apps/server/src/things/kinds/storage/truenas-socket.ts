/**
 * TrueNAS's JSON-RPC socket for its page and buttons (service-dashboards.md SD-51, SD-S17; connections-more.md CM-13…
 * CM-15): the `call` tool's client — `openChannel` under the connection's policy and pinned certificate, the catalog's
 * sign-in (`auth.login_with_api_key` with the key, TLS only), `jsonRpcSession` — but one socket and one sign-in for all
 * of a page's reads (TrueNAS limits sign-ins and refuses batches), the methods one by one, closed at the end.
 */
import { type CatalogEntry, catalogEntry, type JsonValue } from '@whombat/core';
import { externalEffect } from '../../../commit/scope';
import { resolveCredential } from '../../../connections/credentials';
import { connectionPolicy } from '../../../connections/destination';
import { pinOf } from '../../../connections/http';
import { socketCallError, socketLogin } from '../../../connections/socket/call';
import { openChannel, SocketUpgradeRefused } from '../../../connections/socket/channel';
import { type SocketReply, SocketSignInRefused } from '../../../connections/socket/dialect';
import { jsonRpcSession } from '../../../connections/socket/jsonrpc';
import { fillLoginParams, type SocketSpec, socketHttpUrl } from '../../../connections/socket/spec';
import type { CatalogConnectionRow } from '../../../connections/types';
import { ConnectionAuthError } from '../../../connections/types';
import { ApiError, conflict, forbidden } from '../../../lib/errors';
import type { Services } from '../../../services';
import { VaultCallError } from '../../../vault/net';
import { problemOf, ReadProblem } from '../read';

export const TRUENAS = 'TrueNAS';
/** JSON-RPC's “no such method”: an older TrueNAS hasn't got it. */
export const METHOD_NOT_FOUND = '-32601';

export interface TrueNasCall {
  method: string;
  params?: JsonValue;
}

function spec(): { entry: CatalogEntry; spec: SocketSpec } {
  const entry = catalogEntry('truenas');
  if (!entry?.socket) throw new ReadProblem('This server doesn’t know how to talk to TrueNAS.');
  return { entry, spec: entry.socket };
}

/** Why TrueNAS gave nothing, as the page says it. */
export function truenasProblem(err: unknown): ReadProblem {
  if (err instanceof ReadProblem) return err;
  if (err instanceof SocketSignInRefused)
    return err.reason === 'locked'
      ? new ReadProblem('TrueNAS paused sign-ins after too many tries. Whombat tries again in a few minutes.')
      : new ReadProblem(
          'TrueNAS refused Whombat’s key. It turns a key off when it was ever used over plain http.',
          true,
        );
  if (err instanceof SocketUpgradeRefused && err.refused)
    return new ReadProblem('TrueNAS refused Whombat’s sign-in.', true);
  if (err instanceof ConnectionAuthError || err instanceof VaultCallError) return problemOf(err, TRUENAS);
  try {
    const { entry, spec: s } = spec();
    return problemOf(socketCallError(entry, s, err), TRUENAS);
  } catch {
    return problemOf(err, TRUENAS);
  }
}

/**
 * Opens one socket, signs in once and sends `calls` one by one; answers each reply by index. A read (`write` false) is
 * idempotent; a button's call isn't, and is never resent.
 */
export async function truenasCalls(
  services: Services,
  row: CatalogConnectionRow,
  calls: readonly TrueNasCall[],
  { deadlineMs, write = false }: { deadlineMs: number; write?: boolean },
): Promise<SocketReply[]> {
  const { spec: s } = spec();
  const { credential } = await resolveCredential(services, row);
  const login = socketLogin(credential, row.fields);
  return externalEffect(
    write ? 'things.action' : 'things.read',
    async () => {
      const deadlineAt = Date.now() + deadlineMs;
      const policy = await connectionPolicy(services, socketHttpUrl(row.baseUrl, s), {
        ...pinOf(row),
        deadlineMs,
      });
      const channel = await openChannel(socketHttpUrl(row.baseUrl, s), policy, {
        connectMs: Math.min(10_000, deadlineMs),
      });
      try {
        const session = jsonRpcSession(channel);
        if (s.login) {
          if (!login) throw new SocketSignInRefused('needed');
          const params = fillLoginParams(s.login.params, login);
          if (params === null) throw new SocketSignInRefused('needed');
          await session.signIn(s.login.method, params, deadlineAt);
        }
        const out: SocketReply[] = [];
        for (const c of calls) out.push(await session.call(c.method, c.params, { deadlineAt }));
        return out;
      } finally {
        channel.close();
      }
    },
    write ? { refused: (err) => err instanceof ConnectionAuthError } : { idempotent: true },
  );
}

/** A reply's result, or null when it failed (this TrueNAS hasn't got the method, or the key may not). */
export function resultOf(reply: SocketReply | undefined): unknown {
  return reply?.ok ? reply.result : null;
}

/** The reply said “no such method”. */
export const missingMethod = (reply: SocketReply | undefined) =>
  !!reply && !reply.ok && reply.code === METHOD_NOT_FOUND;

/**
 * A button's one call (`pool.scrub.run`, `app.start`, `app.stop`, `alert.dismiss`), its failures in plain words for the
 * toast: needs connecting again, refused, didn't answer, or answered with an error.
 */
export async function truenasAct(
  services: Services,
  row: CatalogConnectionRow,
  call: TrueNasCall,
  what: string,
): Promise<unknown> {
  let reply: SocketReply | undefined;
  try {
    [reply] = await truenasCalls(services, row, [call], { deadlineMs: 20_000, write: true });
  } catch (err) {
    if (err instanceof ConnectionAuthError) throw conflict('TrueNAS needs you to sign in again first.');
    const p = truenasProblem(err);
    if (p.refused) throw forbidden('TrueNAS refused Whombat’s key. Connect it again in Settings.');
    throw new ApiError('unavailable', p.message);
  }
  if (!reply?.ok) {
    const e = reply && !reply.ok ? reply.error : {};
    const words = JSON.stringify(e);
    if (/EACCES|EPERM|ENOTAUTHORIZED|Not authorized|not allowed/i.test(words))
      throw forbidden(`TrueNAS refused: Whombat’s key there may not ${what}.`.slice(0, 300));
    throw new ApiError('unavailable', `TrueNAS answered with an error and didn’t ${what}.`.slice(0, 300));
  }
  return reply.result;
}
