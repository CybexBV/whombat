/**
 * Whombat's own client key in Fusebox (docs/decisions/ai-gateway.md AIG-02, AIG-03): after the management key passed
 * the check, the server reads Fusebox's settings (`GET /api/config/settings`), puts its named client
 * `whombat-<burrow slug>` (“Whombat · <burrow name>”, a new `wbgw_` key) into `named-clients` — replacing its own
 * entry, every other one untouched — and saves them (`PATCH`, revision-checked: a 409 reads again, three tries), then
 * checks the new key on `GET /v1/fusebox/status` (`GET /v1/models` on a Fusebox older than 0.14). An open Fusebox (no keys, no named clients) stays open: nothing is added and
 * no key is sent. Removing the connection takes the entry out again the same way, best effort.
 *
 * Every call goes through the connection destination policy (`connectionFetch`: the home network list or the LAN switch,
 * a pinned certificate, 10 s). The settings hold every client key of that Fusebox: they are read for this and
 * dropped, never logged or stored.
 */
import { createHash } from 'node:crypto';
import { GATEWAY_CALL_TIMEOUT_MS, gatewayClientId, gatewayClientLabel } from '@whombat/core';
import type { CheckCredential } from '../connections/checks';
import { connectionError } from '../connections/errors';
import { connectionFetch, jsonOf, outboundText } from '../connections/http';
import { OutboundError, type OutboundResponse } from '../lib/outbound';
import type { Services } from '../services';
import {
  type FuseboxSettings,
  isOpenFusebox,
  newGatewayClientKey,
  parseFuseboxSettings,
  refusedNamedClients,
  withoutClient,
  withWhombatClient,
} from './fusebox';

/** Tries of a settings change that Fusebox answers 409 (its config changed meanwhile). */
export const SETTINGS_TRIES = 3;
/** The settings answer can be large (models, aliases, providers). */
const SETTINGS_MAX_BYTES = 4 * 1024 * 1024;

export interface FuseboxTarget {
  /** The connection's base URL (its `url` field). */
  baseUrl: string;
  /** The management key as the entry sends it. */
  credential: CheckCredential;
  /** A home-network certificate pinned by the connection (`fingerprint` field). */
  pinnedCertSha256?: string;
}

/** Why provisioning stopped, in the form's words (`check_failed` / `gateway_too_old`). */
function failed(message: string, status?: number) {
  return connectionError('check_failed', status !== undefined ? { status } : {}, message);
}

function tooOld() {
  return connectionError('gateway_too_old');
}

async function call(
  services: Services,
  target: FuseboxTarget,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  write: boolean,
): Promise<OutboundResponse> {
  return connectionFetch(
    services,
    `${target.baseUrl.replace(/\/+$/, '')}${path}`,
    { ...init, headers: { accept: 'application/json', ...(init.headers ?? {}) } },
    {
      deadlineMs: GATEWAY_CALL_TIMEOUT_MS,
      maxBytes: SETTINGS_MAX_BYTES,
      effect: write ? 'gateway.client_key' : 'gateway.settings',
      idempotent: !write,
      ...(target.pinnedCertSha256 ? { pinnedCertSha256: target.pinnedCertSha256 } : {}),
    },
  );
}

/** `GET /api/config/settings` with the management key; throws the form's refusal. */
async function readSettings(services: Services, target: FuseboxTarget): Promise<FuseboxSettings> {
  let res: OutboundResponse;
  try {
    res = await call(
      services,
      target,
      '/api/config/settings',
      { method: 'GET', headers: target.credential.headers },
      false,
    );
  } catch (err) {
    throw failed(`Whombat couldn’t read Fusebox’s settings: ${outboundText(err)}`);
  }
  // A Fusebox without the settings API is older still than one that doesn't know named clients.
  if (res.status === 404) throw tooOld();
  if (res.status === 401 || res.status === 403)
    throw failed('Fusebox didn’t accept the management key for its settings.', res.status);
  if (res.status !== 200) throw failed('Fusebox didn’t answer as expected.', res.status);
  const settings = parseFuseboxSettings(jsonOf(res));
  if (!settings) throw failed('Fusebox didn’t answer as expected.');
  return settings;
}

/**
 * Saves `named-clients` as `edit` makes them from the list read (three tries on 409). Returns false when there was
 * nothing to change.
 */
async function editNamedClients(
  services: Services,
  target: FuseboxTarget,
  edit: (settings: FuseboxSettings) => unknown[] | null,
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    const settings = await readSettings(services, target);
    const list = edit(settings);
    if (!list) return false;
    let res: OutboundResponse;
    try {
      res = await call(
        services,
        target,
        '/api/config/settings',
        {
          method: 'PATCH',
          headers: { ...target.credential.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ revision: settings.revision, changes: { 'named-clients': list } }),
        },
        true,
      );
    } catch (err) {
      throw failed(`Whombat couldn’t save its key in Fusebox: ${outboundText(err)}`);
    }
    if (res.status === 200) return true;
    if (res.status === 409 && attempt < SETTINGS_TRIES) continue;
    if (res.status === 409)
      throw failed('Fusebox’s settings kept changing while Whombat saved its key. Try again.', 409);
    if (refusedNamedClients(res.status, jsonOf(res) ?? res.body.toString('utf8').slice(0, 2000)))
      throw tooOld();
    if (res.status === 401 || res.status === 403)
      throw failed('Fusebox didn’t accept the management key for its settings.', res.status);
    throw failed('Fusebox didn’t save Whombat’s key.', res.status);
  }
}

/** What provisioning made: the client's id and key, or neither for an open Fusebox. */
export interface GatewayKeyMade {
  clientId: string | null;
  clientKey: string | null;
}

/**
 * Whombat's named client id in a Fusebox (AIG-02, AIG-D15): `whombat-<burrow slug>-<6 hex of the burrow id>`, at most 40
 * characters. The burrow id keeps two Whombats whose burrows share a slug (John's box, the dev stack) from replacing each
 * other's key in one Fusebox; reconnecting the same burrow replaces its own.
 */
export function fuseboxClientId(burrow: { id: string; slug: string }): string {
  const suffix = createHash('sha256').update(burrow.id).digest('hex').slice(0, 6);
  return `${gatewayClientId(burrow.slug).slice(0, 33).replace(/-+$/, '')}-${suffix}`;
}

/**
 * Adds (or replaces) Whombat's named client in a Fusebox whose management key just passed the check (AIG-02) and
 * checks the new key. Throws the form's refusal; a key Fusebox took but won't serve is taken out again first.
 */
export async function provisionFusebox(
  services: Services,
  target: FuseboxTarget,
  burrow: { id: string; slug: string; name: string },
): Promise<GatewayKeyMade> {
  const id = fuseboxClientId(burrow);
  const client = { id, label: gatewayClientLabel(burrow.name), key: newGatewayClientKey() };
  let open = false;
  // The entry as it was before this key, to put back if Fusebox won't take the new one.
  let previous: unknown = null;
  await editNamedClients(services, target, (settings) => {
    if (isOpenFusebox(settings)) {
      open = true;
      return null;
    }
    const list = settings.namedClients ?? [];
    previous = list.find((entry) => (entry as { id?: unknown } | null)?.id === id) ?? null;
    return withWhombatClient(list, client, services.clock());
  });
  if (open) return { clientId: null, clientKey: null };
  const status = await probeClientKey(services, target, client.key);
  if (status === 200) return { clientId: id, clientKey: client.key };
  // A reconnect whose new key isn't taken leaves the entry as it was (its old key, which Whombat still holds, and what
  // the person set on it); a first connect takes its entry out again.
  if (previous) await restoreFuseboxClient(services, target, client, previous);
  else await removeFuseboxClient(services, target, id);
  throw failed(
    'Whombat added its key to Fusebox, but Fusebox didn’t take it. Try again.',
    status ?? undefined,
  );
}

/**
 * Whether Fusebox takes a client key: `GET /v1/fusebox/status` (0.14+), which checks only the key, its expiry and its
 * addresses, so the user agents and budgets the person set on the client don't refuse the check; an older Fusebox
 * (404) is asked `GET /v1/models`. The status of the answer, or null when there was none.
 */
async function probeClientKey(
  services: Services,
  target: FuseboxTarget,
  key: string,
): Promise<number | null> {
  const get = async (path: string) => {
    try {
      return (
        await call(
          services,
          target,
          path,
          { method: 'GET', headers: { authorization: `Bearer ${key}` } },
          false,
        )
      ).status;
    } catch (err) {
      if (!(err instanceof OutboundError)) throw err;
      return null;
    }
  };
  const status = await get('/v1/fusebox/status');
  return status === 404 ? get('/v1/models') : status;
}

/**
 * Puts Whombat's entry back as it was before a new key Fusebox didn't take (best effort, never throws). Only while the
 * entry still holds that new key: one changed meanwhile is left alone.
 */
async function restoreFuseboxClient(
  services: Services,
  target: FuseboxTarget,
  client: { id: string; key: string },
  previous: unknown,
): Promise<void> {
  try {
    await editNamedClients(services, target, (settings) => {
      const list = settings.namedClients ?? [];
      let restored = false;
      const next = list.map((entry) => {
        const e = entry as { id?: unknown; key?: unknown } | null;
        if (e?.id !== client.id || e.key !== client.key) return entry;
        restored = true;
        return previous;
      });
      return restored ? next : null;
    });
  } catch (err) {
    services.log.warn(
      { err: err instanceof Error ? err.message.slice(0, 200) : 'error' },
      'could not put Whombat’s client in Fusebox back',
    );
  }
}

/**
 * Takes Whombat's named client out of Fusebox (AIG-03): read, filter out `clientId`, save (three tries on 409). False
 * when Fusebox couldn't be reached or refused; never throws.
 */
export async function removeFuseboxClient(
  services: Services,
  target: FuseboxTarget,
  clientId: string,
): Promise<boolean> {
  try {
    await editNamedClients(services, target, (settings) => {
      const list = settings.namedClients ?? [];
      const next = withoutClient(list, clientId);
      return next.length === list.length ? null : next;
    });
    return true;
  } catch (err) {
    services.log.warn(
      { err: err instanceof Error ? err.message.slice(0, 200) : 'error' },
      'could not remove Whombat’s client from Fusebox',
    );
    return false;
  }
}
