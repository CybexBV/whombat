/**
 * An OAuth client's secret traded for short-lived tokens (docs/decisions/connections-setup.md CS-12; Tailscale): the
 * `client_credentials` sign-in.
 *
 * - The exchange: `POST <tokenUrl>` form `grant_type=client_credentials&client_id=whombat&client_secret=<secret>&scope=
 *   <the level's scopes, space-separated>` → `access_token`, `expires_in`. Minting a token changes nothing in the
 *   service, so it counts as a read (an idempotent effect).
 * - The secret is the connection's sealed secret (AAD `catalog_connection:<id>:secret`); the token is kept sealed in the
 *   OAuth access-token columns with its expiry and used while more than a minute is left (`REFRESH_MARGIN_MS`), then
 *   exchanged again, one exchange at a time per connection (single-flight like an OAuth refresh, CX-D19), outside any
 *   caller's session command; work bound to where the connection went exchanges only while the row it reads again
 *   still goes there (`bound-targets.ts`).
 * - A secret the token endpoint refuses (400/401), or a level its client can't have (`invalid_scope`), marks the
 *   connection `needs_reauth` (`token_invalid`), as a refused pasted token does: Replace token fixes it.
 */
import {
  type CatalogEntry,
  type CatalogSignIn,
  CONNECTION_ACCESS_LABELS,
  type ConnectionAccessLevel,
  catalogEntry,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { outsideCommandScope } from '../commit/scope';
import { catalogConnections } from '../db/schema/index';
import type { Services } from '../services';
import { keepBoundRow, type SignInFlight, sharedSignIn } from './bound-targets';
import { markNeedsReauth } from './commands';
import { openConnectionSecret, sealConnectionSecret } from './crypto';
import { connectionError } from './errors';
import { connectionFetch, formBody, jsonOf, outboundText } from './http';
import { REFRESH_MARGIN_MS } from './refresh';
import { type CatalogConnectionRow, ConnectionAuthError } from './types';

export type ClientCredentialsMethod = Extract<CatalogSignIn, { kind: 'client_credentials' }>;

/** The `client_id` Whombat sends: the secret alone names the client (CS-12: “anything”). */
export const CLIENT_CREDENTIALS_ID = 'whombat';

/** The entry's OAuth client sign-in, or null. */
export function clientCredentialsMethod(entry: CatalogEntry): ClientCredentialsMethod | null {
  const method = entry.signIn.find((m) => m.kind === 'client_credentials');
  return method?.kind === 'client_credentials' ? method : null;
}

/** Why an exchange gave no token: the secret was refused, the level's scopes were, or anything else. */
export class ClientCredentialsError extends Error {
  constructor(
    readonly reason: 'refused' | 'scope' | 'other',
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'ClientCredentialsError';
  }
}

export interface ExchangedToken {
  accessToken: string;
  expiresAt: Date | null;
  scopes: string[];
}

/** One exchange of the secret for a token at `level`. Throws `ClientCredentialsError` or `OutboundError`. */
export async function exchangeClientSecret(
  services: Services,
  method: ClientCredentialsMethod,
  secret: string,
  level: ConnectionAccessLevel,
): Promise<ExchangedToken> {
  const scopes = method.scopes[level];
  const res = await connectionFetch(
    services,
    method.tokenUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: formBody({
        grant_type: 'client_credentials',
        client_id: CLIENT_CREDENTIALS_ID,
        client_secret: secret,
        scope: scopes.length ? scopes.join(' ') : undefined,
      }),
    },
    { effect: 'connections.exchange', idempotent: true },
  );
  const doc = (jsonOf(res) ?? {}) as Record<string, unknown>;
  if (res.status < 200 || res.status >= 300) {
    const error = typeof doc.error === 'string' ? doc.error : null;
    if (error === 'invalid_scope')
      throw new ClientCredentialsError('scope', res.status, 'The level’s scopes were refused.');
    if (res.status === 400 || res.status === 401)
      throw new ClientCredentialsError('refused', res.status, 'The client secret was refused.');
    throw new ClientCredentialsError('other', res.status, `The token endpoint answered ${res.status}.`);
  }
  const accessToken = typeof doc.access_token === 'string' && doc.access_token ? doc.access_token : null;
  if (!accessToken)
    throw new ClientCredentialsError('other', res.status, 'The token endpoint sent no token.');
  const expiresIn = typeof doc.expires_in === 'number' ? doc.expires_in : Number(doc.expires_in);
  return {
    accessToken,
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(services.clock().getTime() + expiresIn * 1000)
        : null,
    scopes: typeof doc.scope === 'string' ? doc.scope.split(/\s+/).filter(Boolean) : scopes,
  };
}

/**
 * The exchange on the connect side (create, Replace token, a new level): a failure is the form's `check_failed`, in
 * our words.
 */
export async function exchangeForConnect(
  services: Services,
  entry: CatalogEntry,
  method: ClientCredentialsMethod,
  secret: string,
  level: ConnectionAccessLevel,
): Promise<ExchangedToken> {
  try {
    return await exchangeClientSecret(services, method, secret, level);
  } catch (err) {
    if (!(err instanceof ClientCredentialsError))
      throw connectionError('check_failed', {}, outboundText(err));
    const status = err.status !== null ? { status: err.status } : {};
    if (err.reason === 'refused')
      throw connectionError(
        'check_failed',
        status,
        `${entry.name} refused the client secret. Check it and try again.`,
      );
    if (err.reason === 'scope') {
      const other: ConnectionAccessLevel = level === 'read' ? 'manage' : 'read';
      throw connectionError(
        'check_failed',
        status,
        `${entry.name} won’t give this client what ${CONNECTION_ACCESS_LABELS[level]} needs. Give it those scopes in ${entry.name}, or choose ${CONNECTION_ACCESS_LABELS[other]}.`,
      );
    }
    throw connectionError(
      'check_failed',
      status,
      `${entry.name} didn’t give a token for that secret (it answered ${err.status ?? 'nothing'}).`,
    );
  }
}

const NO_SECRET_TEXT = 'This connection has no client secret.';
const REFUSED_TEXT = 'The service refused the client secret. Replace it in Settings → Connections.';

const inflight = new WeakMap<
  Services,
  Map<string, SignInFlight<{ accessToken: string; expiresAt: Date | null }>>
>();

function freshAccess(
  services: Services,
  row: CatalogConnectionRow,
): { accessToken: string; expiresAt: Date | null } | null {
  if (!row.accessTokenEnc) return null;
  if (row.accessExpiresAt && row.accessExpiresAt.getTime() - services.clock().getTime() <= REFRESH_MARGIN_MS)
    return null;
  return {
    accessToken: openConnectionSecret(services.custody, row.id, 'access', row.accessTokenEnc),
    expiresAt: row.accessExpiresAt,
  };
}

/**
 * The connection's access token: the cached one while it is good for another minute (unless `force`: the service
 * refused it), else one exchange (single-flight). Throws `ConnectionAuthError` when the secret is refused (the
 * connection is then `needs_reauth`).
 */
export async function clientCredentialsAccess(
  services: Services,
  row: CatalogConnectionRow,
  opts: { force?: boolean } = {},
): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const fresh = opts.force ? null : freshAccess(services, row);
  if (fresh) return fresh;
  let map = inflight.get(services);
  if (!map) {
    map = new Map();
    inflight.set(services, map);
  }
  // Shared by every caller bound alike that joins it: it belongs to none of their session commands (CS-07).
  return sharedSignIn(map, row.id, () =>
    outsideCommandScope(() => exchangeAgain(services, row.id, opts.force ?? false)),
  );
}

async function currentRow(services: Services, id: string): Promise<CatalogConnectionRow | null> {
  const [row] = await services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
  return row ?? null;
}

async function exchangeAgain(
  services: Services,
  id: string,
  force: boolean,
  again = false,
): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const row = await currentRow(services, id);
  if (!row) throw new ConnectionAuthError(NO_SECRET_TEXT);
  // Bound to where the connection went: one changed since asks the service nothing and writes nothing.
  keepBoundRow(row);
  const fresh = force ? null : freshAccess(services, row);
  if (fresh) return fresh;
  const entry = catalogEntry(row.catalogId);
  const method = entry ? clientCredentialsMethod(entry) : null;
  if (!method || !row.secretEnc) throw new ConnectionAuthError(NO_SECRET_TEXT);
  const secret = openConnectionSecret(services.custody, row.id, 'secret', row.secretEnc);
  let token: ExchangedToken;
  try {
    token = await exchangeClientSecret(services, method, secret, row.access);
  } catch (err) {
    if (!(err instanceof ClientCredentialsError) || err.reason === 'other') throw err;
    // A new secret (or level) that landed meanwhile decides, not the old one's refusal.
    const now = await currentRow(services, id);
    if (now && now.credentialVersion !== row.credentialVersion && !again)
      return exchangeAgain(services, id, true, true);
    await markNeedsReauth(services, row, 'token_invalid', {
      message:
        err.reason === 'scope'
          ? 'The service won’t give this client what its level needs.'
          : 'The service refused the client secret.',
    });
    throw new ConnectionAuthError(REFUSED_TEXT);
  }
  const stored = await services.pipeline.transactAccount((tx) =>
    tx
      .update(catalogConnections)
      .set({
        accessTokenEnc: sealConnectionSecret(services.custody, row.id, 'access', token.accessToken),
        accessExpiresAt: token.expiresAt,
        scopes: token.scopes,
        updatedAt: services.clock(),
      })
      .where(
        and(
          eq(catalogConnections.id, row.id),
          eq(catalogConnections.credentialVersion, row.credentialVersion),
        ),
      )
      .returning({ id: catalogConnections.id }),
  );
  if (stored.length === 0) {
    // Its secret or level changed while the service answered: this token is the old one's.
    if (!again) return exchangeAgain(services, id, true, true);
    throw new ConnectionAuthError('This connection changed. Try again.');
  }
  return { accessToken: token.accessToken, expiresAt: token.expiresAt };
}
