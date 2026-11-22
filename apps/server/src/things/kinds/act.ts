/**
 * What every kind's buttons share (service-dashboards.md SD-07, SD-S04): one call as the connection that changes
 * something there (`signedConnectionFetch`: its policy, its credential), reported to the command as an external effect
 * that is never resent, with refusals and failures in plain words for the toast — never the other side's. Writes only:
 * reads go through `read.ts`. Never to delete anything, update or restart the service, or change its settings (SD-02).
 */
import { externalEffect } from '../../commit/scope';
import { signedConnectionFetch } from '../../connections/http';
import { type CatalogConnectionRow, ConnectionAuthError } from '../../connections/types';
import { ApiError, conflict, forbidden } from '../../lib/errors';
import type { Services } from '../../services';
import { VaultCallError } from '../../vault/net';
import { KIND_MAX_BYTES } from './read';

/** A button's call's deadline, and the longest a kind may ask for (a certificate's renewal, a container's restart). */
export const ACT_DEADLINE_MS = 15_000;
export const ACT_DEADLINE_MAX_MS = 90_000;

/** One call a button makes: SABnzbd's API is GETs with a `mode`; most others POST JSON. */
export interface ActCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  path: string;
  query?: Record<string, string>;
  /** JSON (sent with its content type), or a body as is with `contentType`. */
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
  /** Its own deadline when the service answers only once it is done (default `ACT_DEADLINE_MS`, at most 90 s). */
  deadlineMs?: number;
}

/** The answer of a button's call: its status and its JSON, when it had any. */
export interface ActAnswer {
  status: number;
  json: unknown;
}

/**
 * Makes one call as the connection for a button; a refusal or failure is an `ApiError` about `name` (“SABnzbd”) in plain
 * words: needs connecting again (409), refused (403), didn't answer or answered with an error (503).
 */
export async function actAs(
  services: Services,
  row: CatalogConnectionRow,
  name: string,
  call: ActCall,
): Promise<ActAnswer> {
  const search = call.query ? new URLSearchParams(call.query).toString() : '';
  const url = `${row.baseUrl.replace(/\/+$/, '')}${call.path}${search ? `?${search}` : ''}`;
  const raw = call.body === undefined || call.contentType !== undefined;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(call.body !== undefined ? { 'Content-Type': call.contentType ?? 'application/json' } : {}),
    ...call.headers,
  };
  let res: Awaited<ReturnType<typeof signedConnectionFetch>>;
  try {
    res = await externalEffect(
      'things.action',
      () =>
        signedConnectionFetch(
          services,
          row,
          {
            method: call.method,
            url,
            headers,
            ...(call.body !== undefined ? { body: raw ? String(call.body) : JSON.stringify(call.body) } : {}),
          },
          {
            maxBytes: KIND_MAX_BYTES,
            deadlineMs: Math.min(ACT_DEADLINE_MAX_MS, Math.max(1_000, call.deadlineMs ?? ACT_DEADLINE_MS)),
          },
        ),
      { refused: (err) => err instanceof ConnectionAuthError },
    );
  } catch (err) {
    if (err instanceof ConnectionAuthError) throw conflict(`${name} needs you to sign in again first.`);
    if (err instanceof VaultCallError && err.reason === 'timeout')
      throw new ApiError(
        'unavailable',
        `${name} didn’t answer in time. Look again in a moment: it may have done it.`,
      );
    if (err instanceof VaultCallError && err.reason === 'not_allowed')
      throw forbidden(`Whombat may not call ${name}’s address any more.`);
    throw new ApiError('unavailable', `Whombat couldn’t reach ${name} just now.`);
  }
  if (res.status === 401 || res.status === 403)
    throw forbidden(`${name} refused: Whombat’s account there may not do that.`);
  if (res.status === 412)
    throw conflict(
      `Something else changed in ${name} at the same time, so Whombat didn’t save it. Try again.`,
    );
  if (res.status >= 400)
    throw new ApiError('unavailable', `${name} answered with an error and didn’t do it.`);
  let json: unknown = null;
  const text = res.body.toString('utf8');
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json };
}
