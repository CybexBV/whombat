/**
 * Refreshing an OAuth connection's access token (CX-12…CX-15), for `credentials.ts` and the connect side's own checks:
 * - the stored access token is used while more than a minute is left (unless `force`: the service refused it);
 * - otherwise one refresh at a time per connection (single-flight), outside any caller's session command (CS-07),
 *   with the refresh token at the authorization server the connection signed in with (`resource` for MCP);
 * - every write is conditional on the row still holding the refresh token that was used (IN-22): a reconnect that
 *   lands meanwhile wins, and the refresh starts over once with the new grant;
 * - `invalid_grant` (or a client the server no longer knows) marks the connection `needs_reauth`, tells whoever can
 *   fix it once a day, and throws `ConnectionAuthError`; an MCP registration the server no longer knows is dropped
 *   (connection-signin.md SG-19b).
 */
import { and, eq } from 'drizzle-orm';
import { outsideCommandScope } from '../commit/scope';
import { REFRESH_MARGIN_MS } from '../connectors/tokens';
import { catalogConnections } from '../db/schema/index';
import type { Services } from '../services';
import { clientForRow, dropDeadRegistration, endpointsForRow } from './clients';
import { markNeedsReauth } from './commands';
import { openConnectionSecret, sealConnectionSecret } from './crypto';
import { OAuthTokenError, tokenRequest } from './oauth';
import { type CatalogConnectionRow, ConnectionAuthError } from './types';

// The same margin as a Google account's tokens: one rule for when an OAuth access token is too close to its end.
export { REFRESH_MARGIN_MS };

const NEEDS_REAUTH_TEXT = 'This connection needs you to sign in again.';

const inflight = new WeakMap<
  Services,
  Map<string, Promise<{ accessToken: string; expiresAt: Date | null }>>
>();

function freshAccess(
  services: Services,
  row: CatalogConnectionRow,
): { accessToken: string; expiresAt: Date | null } | null {
  if (!row.accessTokenEnc) return null;
  const now = services.clock().getTime();
  // No expiry known: good until the service refuses it (then `force`).
  if (row.accessExpiresAt && row.accessExpiresAt.getTime() - now <= REFRESH_MARGIN_MS) return null;
  return {
    accessToken: openConnectionSecret(services.custody, row.id, 'access', row.accessTokenEnc),
    expiresAt: row.accessExpiresAt,
  };
}

export async function refreshConnectionAccess(
  services: Services,
  row: CatalogConnectionRow,
  opts: { force?: boolean } = {},
): Promise<{ accessToken: string; expiresAt: Date | null }> {
  if (row.status === 'needs_reauth') throw new ConnectionAuthError(NEEDS_REAUTH_TEXT);
  const fresh = opts.force ? null : freshAccess(services, row);
  if (fresh) return fresh;
  let map = inflight.get(services);
  if (!map) {
    map = new Map();
    inflight.set(services, map);
  }
  let pending = map.get(row.id);
  if (!pending) {
    const m = map;
    // Shared by every caller that joins it: it belongs to none of their session commands (CS-07).
    pending = outsideCommandScope(() => refresh(services, row.id, opts.force ?? false)).finally(() =>
      m.delete(row.id),
    );
    map.set(row.id, pending);
  }
  return pending;
}

async function refresh(
  services: Services,
  id: string,
  force: boolean,
  again = false,
): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const [row] = await services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
  if (!row || row.status === 'needs_reauth') throw new ConnectionAuthError(NEEDS_REAUTH_TEXT);
  const fresh = force ? null : freshAccess(services, row);
  if (fresh) return fresh;
  if (!row.refreshTokenEnc) {
    // An access token without a refresh token: once it expires (or is refused) the person signs in again.
    await markNeedsReauth(services, row, 'expired', { message: 'Its sign-in expired.' });
    throw new ConnectionAuthError(NEEDS_REAUTH_TEXT);
  }
  const [client, endpoints] = await Promise.all([
    clientForRow(services, row),
    endpointsForRow(services, row),
  ]);
  if (!client || !endpoints) {
    await markNeedsReauth(services, row, row.signIn === 'app_oauth' ? 'app_removed' : 'revoked', {
      refreshTokenEnc: row.refreshTokenEnc,
    });
    throw new ConnectionAuthError(NEEDS_REAUTH_TEXT);
  }
  const refreshToken = openConnectionSecret(services.custody, row.id, 'refresh', row.refreshTokenEnc);
  let tokens: Awaited<ReturnType<typeof tokenRequest>>;
  try {
    tokens = await tokenRequest(
      services,
      endpoints.token,
      client,
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        ...(endpoints.resource ? { resource: endpoints.resource } : {}),
      },
      'connections.refresh',
    );
  } catch (err) {
    if (err instanceof OAuthTokenError && (err.code === 'invalid_grant' || err.code === 'invalid_client')) {
      // A registration the server no longer knows is dropped: the next sign-in registers afresh (SG-19b).
      if (err.code === 'invalid_client' && row.signIn === 'mcp_oauth')
        await dropDeadRegistration(services, row.clientId, client.clientId);
      const marked = await markNeedsReauth(services, row, 'revoked', {
        refreshTokenEnc: row.refreshTokenEnc,
        message: 'The service signed this connection out.',
      });
      // The old grant died, but a new one arrived meanwhile (a reconnect): use that.
      if (!marked && !again) return refresh(services, id, false, true);
      throw new ConnectionAuthError('The service signed this connection out. Connect it again.');
    }
    throw err;
  }
  const now = services.clock();
  const stored = await services.pipeline.transactAccount((tx) =>
    tx
      .update(catalogConnections)
      .set({
        accessTokenEnc: sealConnectionSecret(services.custody, row.id, 'access', tokens.accessToken),
        accessExpiresAt: tokens.expiresAt,
        ...(tokens.refreshToken
          ? {
              refreshTokenEnc: sealConnectionSecret(services.custody, row.id, 'refresh', tokens.refreshToken),
            }
          : {}),
        ...(tokens.scopes.length ? { scopes: tokens.scopes } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(catalogConnections.id, row.id),
          eq(catalogConnections.refreshTokenEnc, row.refreshTokenEnc as string),
        ),
      )
      .returning({ id: catalogConnections.id }),
  );
  if (stored.length === 0) {
    // Reconnected while the server answered: this token is the old grant's.
    if (!again) return refresh(services, id, false, true);
    throw new ConnectionAuthError('This connection changed. Try again.');
  }
  return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
}
