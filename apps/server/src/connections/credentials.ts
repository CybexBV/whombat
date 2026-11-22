/**
 * A connection's credential for one outbound call (docs/decisions/connections-catalog.md CX-10…CX-15, CX-36): made on
 * the server for each request and never handed to the agent, its runner or its commands.
 *
 * - Token kinds (`token`, `nextcloud_login`): the sealed secret (`crypto.ts`, AAD `catalog_connection:<id>:secret`) on
 *   the request as the entry says (`tokenCredential`: bearer, a header template, basic auth with the `username` field
 *   for a Nextcloud login, a query parameter).
 * - OAuth kinds (`ha_oauth`, `mcp_oauth`, `app_oauth`): the sealed access token (AAD `catalog_connection:<id>:access`)
 *   while it is good for another minute, else a refresh (`refresh.ts`, single-flight, marks `needs_reauth` on
 *   `invalid_grant`). `forceRefresh` after a 401.
 * - `client_credentials` (Tailscale's OAuth client, connections-setup.md CS-12): the cached access token while it is
 *   good for another minute, else the sealed client secret exchanged again (`client-credentials.ts`, single-flight;
 *   a refused secret marks `needs_reauth`). An answer is checked against both.
 * - `none` (a Custom MCP server without sign-in): nothing.
 * - A token whose `auth` is `session` (Pi-hole, Nginx Proxy Manager; docs/decisions/connections-more.md CM-10, CM-11):
 *   the kept session while it is good for another minute, else a sign-in with the sealed password (`session.ts`,
 *   single-flight; a refused password marks `needs_reauth`), applied as the entry says. An answer is checked against
 *   the password and the session.
 *
 * A connection that needs connecting again throws `ConnectionAuthError` before anything is sent. The connect side's
 * checks use the same credential (`connect.ts` `credentialOf`).
 */
import { catalogEntry, sessionCredential, type TokenAuth, tokenCredential } from '@whombat/core';
import type { Services } from '../services';
import type { SecretForms } from '../vault/scrub';
import { keepBoundTarget } from './bound-targets';
import { clientCredentialsAccess } from './client-credentials';
import { openConnectionSecret } from './crypto';
import { refreshConnectionAccess } from './refresh';
import { sessionAccess, sessionAuthOf } from './session';
import { type CatalogConnectionRow, ConnectionAuthError, type ConnectionCredential } from './types';

const OAUTH_KINDS = new Set(['ha_oauth', 'mcp_oauth', 'app_oauth']);

/** The header shape of a token connection: what it stored, else a Nextcloud login's basic auth. */
function authOf(row: CatalogConnectionRow): TokenAuth {
  if (row.auth && !sessionAuthOf(row.auth)) return row.auth;
  if (row.signIn === 'nextcloud_login') return { type: 'basic', usernameField: 'username' };
  return { type: 'bearer' };
}

export interface CredentialOptions {
  /** The service refused the access token: refresh it even if it looks good. */
  forceRefresh?: boolean;
  /**
   * “Check again” of a token connection that needs connecting again: its stored token is tried once more (a pass makes
   * it active). Calls never pass it.
   */
  evenIfNeedsReauth?: boolean;
}

/**
 * The credential and the secret forms an answer is checked against (VT-42: an echo is withheld). Work bound to where a
 * connection's calls go (`bound-targets.ts`: an approved call, a page's action) gets it only while `row` and the
 * connection as it is stored once the credential is in hand still go there: a refresh or a new sign-in reads the
 * connection again, and one that changed throws `ConnectionChangedError` before anything is signed.
 */
export async function resolveCredential(
  services: Services,
  row: CatalogConnectionRow,
  opts: CredentialOptions = {},
): Promise<{ credential: ConnectionCredential; forms: SecretForms[] }> {
  const resolved = await credentialOf(services, row, opts);
  await keepBoundTarget(services, row);
  return resolved;
}

async function credentialOf(
  services: Services,
  row: CatalogConnectionRow,
  opts: CredentialOptions,
): Promise<{ credential: ConnectionCredential; forms: SecretForms[] }> {
  if (row.status === 'needs_reauth' && !(opts.evenIfNeedsReauth && !OAUTH_KINDS.has(row.signIn)))
    throw new ConnectionAuthError('This connection needs you to sign in again.');
  const entry = catalogEntry(row.catalogId);
  if (!entry || entry.transport === 'builtin')
    throw new Error(`${row.catalogId} isn’t a catalog connection this server knows.`);
  if (row.signIn === 'none')
    return {
      credential: { headers: {}, query: {}, version: String(row.credentialVersion) },
      forms: [],
    };
  if (OAUTH_KINDS.has(row.signIn)) {
    // The stored access token while it is good for another minute, else one refresh (single-flight, refresh.ts).
    const { accessToken, expiresAt } = await refreshConnectionAccess(services, row, {
      force: opts.forceRefresh === true,
    });
    return {
      credential: {
        headers: { Authorization: `Bearer ${accessToken}` },
        query: {},
        version: `${row.credentialVersion}:${expiresAt?.getTime() ?? ''}`,
      },
      forms: [{ secret: accessToken }],
    };
  }
  if (row.signIn === 'client_credentials') {
    const { accessToken, expiresAt } = await clientCredentialsAccess(services, row, {
      force: opts.forceRefresh === true,
    });
    const clientSecret = row.secretEnc
      ? openConnectionSecret(services.custody, row.id, 'secret', row.secretEnc)
      : null;
    return {
      credential: {
        headers: { Authorization: `Bearer ${accessToken}` },
        query: {},
        version: `${row.credentialVersion}:${expiresAt?.getTime() ?? ''}`,
      },
      forms: [{ secret: accessToken }, ...(clientSecret ? [{ secret: clientSecret }] : [])],
    };
  }
  if (!row.secretEnc) throw new ConnectionAuthError('This connection has no token yet.');
  const secret = openConnectionSecret(services.custody, row.id, 'secret', row.secretEnc);
  const session = sessionAuthOf(row.auth);
  if (session) {
    const { token, expiresAt } = await sessionAccess(services, row, { force: opts.forceRefresh === true });
    return {
      credential: {
        ...sessionCredential(session.apply, token),
        version: `${row.credentialVersion}:${expiresAt.getTime()}`,
      },
      forms: [{ secret }, { secret: token }],
    };
  }
  const auth = authOf(row);
  const made = tokenCredential(entry, auth, secret, row.fields);
  if (!made) throw new ConnectionAuthError('A field the connection’s sign-in needs is missing.');
  const username = auth.type === 'basic' ? row.fields[auth.usernameField] : undefined;
  return {
    credential: { ...made, secret, version: String(row.credentialVersion) },
    forms: [{ secret, username }],
  };
}

export async function credentialFor(
  services: Services,
  row: CatalogConnectionRow,
  opts: CredentialOptions = {},
): Promise<ConnectionCredential> {
  return (await resolveCredential(services, row, opts)).credential;
}
