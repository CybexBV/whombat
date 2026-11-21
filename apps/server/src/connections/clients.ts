/**
 * The OAuth clients catalog sign-ins use (CX-12…CX-14, CX-19, CX-D05):
 * - Home Assistant: this Whombat's address as `client_id`, no secret (IndieAuth);
 * - MCP authorization: one dynamic registration per issuer, kept sealed in `connection_clients` and covering every MCP
 *   redirect URI (a box has no public address an authorization server could fetch a metadata document from);
 * - `app_oauth`: the app the person registered (`connector_apps`, provider = catalog id; the secret optional where the
 *   provider takes a PKCE public client).
 *
 * A connection's `client_id` column records which: the literal client id for Home Assistant (an `https://…` URL), a
 * `connection_clients` id (`ccl_…`) for a registration, null for the person's app.
 */
import { catalogEntry, catalogSignIn, randomIdBody } from '@whombat/core';
import { and, eq, isNotNull } from 'drizzle-orm';
import { managedAppOrigin } from '../config';
import { openAppSecret } from '../connectors/crypto';
import { catalogConnections, connectionClients, connectorApps } from '../db/schema/index';
import type { Services } from '../services';
import { clientAad, openJson, sealJson } from './crypto';
import {
  type AuthServerMetadata,
  asksOfflineAccess,
  discoverAuthServer,
  type OAuthClient,
  OAuthFlowError,
  registerClient,
  withOfflineAccess,
} from './oauth';
import { haClientId, mcpRedirectUris } from './redirect';
import type { CatalogConnectionRow } from './types';

/** The person's app of an `app_oauth` entry, or null. */
export async function appClient(services: Services, catalogId: string): Promise<OAuthClient | null> {
  const [row] = await services.db
    .select()
    .from(connectorApps)
    .where(eq(connectorApps.provider, catalogId as never));
  if (!row) return null;
  const secret = row.clientSecretEnc ? openAppSecret(services.custody, catalogId, row.clientSecretEnc) : null;
  return {
    clientId: row.clientId,
    clientSecret: secret,
    authMethod: secret ? 'client_secret_post' : 'none',
  };
}

/** A stored dynamic registration. */
export async function storedClient(services: Services, id: string): Promise<OAuthClient | null> {
  const [row] = await services.db.select().from(connectionClients).where(eq(connectionClients.id, id));
  return row ? openJson<OAuthClient>(services.custody, clientAad(row.id), row.clientEnc) : null;
}

/** Whether a connection signed in through this registration holds a refresh token (the server issues them anyway). */
async function refreshesThrough(services: Services, ref: string): Promise<boolean> {
  const [row] = await services.db
    .select({ id: catalogConnections.id })
    .from(catalogConnections)
    .where(and(eq(catalogConnections.clientId, ref), isNotNull(catalogConnections.refreshTokenEnc)))
    .limit(1);
  return !!row;
}

/**
 * The client for an MCP authorization server (CX-13, CT-268), and the scope to ask with: a metadata document when it
 * supports them and can reach this Whombat, else the stored registration, else a new registration covering every MCP
 * redirect URI. Throws `OAuthFlowError` when the server offers neither.
 *
 * - The scope gains `offline_access` where the server lists it (connection-signin.md SG-19a).
 * - The stored registration is kept while it covers this sign-in's redirect URI: a new `mcp_oauth` entry in the
 *   catalog doesn't make another issuer's registration again, which would leave its connections' refresh tokens
 *   with a client the server no longer knows them by (SG-S43).
 * - One registered without `offline_access` is made again once with it, unless a connection signed in through it
 *   holds a refresh token: then the server issues them anyway, and its scope stays as it was (SG-S44).
 */
export async function mcpClientFor(
  services: Services,
  meta: AuthServerMetadata,
  scope: string | null,
  redirectUri: string,
): Promise<{ client: OAuthClient; ref: string; scope: string | null }> {
  const wanted = withOfflineAccess(scope, meta.scopes);
  if (!meta.registrationEndpoint)
    throw new OAuthFlowError(
      'no_registration',
      meta.clientMetadataDocuments
        ? 'This server needs to reach this Whombat at a public https address to sign in.'
        : 'This server doesn’t let Whombat register to sign in.',
    );
  const redirectUris = mcpRedirectUris(services.config);
  const [existing] = await services.db
    .select()
    .from(connectionClients)
    .where(eq(connectionClients.issuer, meta.issuer));
  if (existing && existing.method === 'dcr' && existing.redirectUri.split(' ').includes(redirectUri)) {
    const client = openJson<OAuthClient>(services.custody, clientAad(existing.id), existing.clientEnc);
    if (!asksOfflineAccess(wanted) || asksOfflineAccess(client.scope))
      return { client, ref: existing.id, scope: wanted };
    if (await refreshesThrough(services, existing.id)) return { client, ref: existing.id, scope };
  }
  const client = await registerClient(services, meta.registrationEndpoint, {
    redirectUris,
    clientUri: managedAppOrigin(services.config),
    scope: wanted,
  });
  const id = existing?.id ?? `ccl_${randomIdBody(12)}`;
  const clientEnc = sealJson(services.custody, clientAad(id), client);
  const wantedUris = redirectUris.join(' ');
  const now = services.clock();
  await services.pipeline.transactAccount((tx) =>
    tx
      .insert(connectionClients)
      .values({
        id,
        issuer: meta.issuer,
        clientEnc,
        redirectUri: wantedUris,
        method: 'dcr',
        registeredAt: now,
      })
      .onConflictDoUpdate({
        target: connectionClients.issuer,
        // The sealed value is bound to `id`, so a registration that raced this one is replaced whole.
        set: { id, clientEnc, redirectUri: wantedUris, method: 'dcr', registeredAt: now },
      }),
  );
  return { client, ref: id, scope: wanted };
}

/**
 * A registration the server no longer knows (`invalid_client` or `unauthorized_client` at the exchange or a refresh,
 * SG-19b) is dropped, so the next sign-in registers afresh. Only while it still holds the client that was refused:
 * one made again meanwhile stays (SG-S45). Connections still pointing at it sign in again (their client is gone).
 */
export async function dropDeadRegistration(
  services: Services,
  ref: string | null,
  clientId: string,
): Promise<void> {
  if (!ref?.startsWith('ccl_')) return;
  const [row] = await services.db.select().from(connectionClients).where(eq(connectionClients.id, ref));
  if (!row) return;
  let stored: OAuthClient;
  try {
    stored = openJson<OAuthClient>(services.custody, clientAad(row.id), row.clientEnc);
  } catch {
    return;
  }
  if (stored.clientId !== clientId) return;
  await services.pipeline.transactAccount((tx) =>
    tx
      .delete(connectionClients)
      .where(and(eq(connectionClients.id, row.id), eq(connectionClients.clientEnc, row.clientEnc))),
  );
  services.log.info(
    { issuer: row.issuer },
    'connection oauth: dropped a registration the server no longer knows',
  );
}

/** The client a connection signed in with, to refresh or revoke its tokens; null when it is gone. */
export async function clientForRow(
  services: Services,
  row: CatalogConnectionRow,
): Promise<OAuthClient | null> {
  switch (row.signIn) {
    case 'ha_oauth':
      return { clientId: row.clientId ?? haClientId(services.config), authMethod: 'none' };
    case 'app_oauth':
      return appClient(services, row.catalogId);
    case 'mcp_oauth':
      if (!row.clientId) return null;
      if (/^https?:\/\//.test(row.clientId)) return { clientId: row.clientId, authMethod: 'none' };
      return storedClient(services, row.clientId);
    default:
      return null;
  }
}

/** Where a connection's tokens are refreshed and revoked. */
export async function endpointsForRow(
  services: Services,
  row: CatalogConnectionRow,
): Promise<{ token: string; revoke: string | null; resource: string | null } | null> {
  switch (row.signIn) {
    case 'ha_oauth':
      return { token: `${row.baseUrl}/auth/token`, revoke: `${row.baseUrl}/auth/revoke`, resource: null };
    case 'app_oauth': {
      const entry = catalogEntry(row.catalogId);
      const method = entry ? catalogSignIn(entry, 'app_oauth') : null;
      return method?.kind === 'app_oauth'
        ? { token: method.tokenUrl, revoke: method.revokeUrl ?? null, resource: null }
        : null;
    }
    case 'mcp_oauth': {
      if (!row.issuer) return null;
      const meta = await discoverAuthServer(services, row.issuer);
      return { token: meta.tokenEndpoint, revoke: meta.revocationEndpoint, resource: row.resource };
    }
    default:
      return null;
  }
}
