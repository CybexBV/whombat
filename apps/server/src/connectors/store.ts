/**
 * People's connections (docs/decisions/connectors.md CN-04…CN-07): stored after Google's callback, checked,
 * marked `needs_reauth`, removed. Account-level writes (CN-07) through `pipeline.transactAccount`; tokens are
 * sealed per row and purpose (`connectors/crypto.ts`) and never leave the server.
 */
import {
  CONNECTOR_SERVICES,
  type Connection,
  type ConnectorProvider,
  type ConnectorService,
  googleServicesGranted,
  microsoftServicesGranted,
  newId,
  type ReauthReason,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { externalEffect } from '../commit/scope';
import { connections } from '../db/schema/index';
import { lockedConnectorCount } from '../domain/licence-usage';
import { notFound } from '../lib/errors';
import { iso } from '../lib/time';
import type { Services } from '../services';
import { runGoogleChecks } from './checks';
import { openConnectionToken, sealConnectionToken } from './crypto';
import type { ConnectionRow } from './lookup';
import { providerOAuth, providerWorkspace } from './providers';
import { ConnectionUnavailableError, type GoogleTokens, type GoogleUserInfo } from './types';

/** A connection as its person's clients see it (no tokens). */
export function toConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    name: row.name.slice(0, 200),
    services: CONNECTOR_SERVICES.filter((s) => row.services.includes(s)),
    status: row.status,
    reauthReason: row.status === 'needs_reauth' ? (row.reauthReason ?? 'revoked') : null,
    checks: row.checks,
    checkedAt: row.checkedAt ? iso(row.checkedAt) : null,
    // An IMAP account's servers and username (CM-29); never the password. Absent for Google and Microsoft 365.
    ...(row.provider === 'imap' && row.mailSettings
      ? {
          mail: {
            imapHost: row.mailSettings.imap.host,
            smtpHost: row.mailSettings.smtp.host,
            username: (row.mailSettings.username ?? row.email).slice(0, 320),
          },
        }
      : {}),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    lastUsedAt: row.lastUsedAt ? iso(row.lastUsedAt) : null,
  };
}

/** The account's connections, in provider order. */
export async function connectionsOfAccount(services: Services, accountId: string): Promise<ConnectionRow[]> {
  return services.db.select().from(connections).where(eq(connections.accountId, accountId));
}

/** One of the account's connections, or 404 (another account's connection does not exist for them). */
export async function ownConnection(
  services: Services,
  accountId: string,
  connectionId: string,
): Promise<ConnectionRow> {
  const [row] = await services.db
    .select()
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.accountId, accountId)));
  if (!row) throw notFound('Connection');
  return row;
}

async function connectionById(services: Services, id: string): Promise<ConnectionRow> {
  const [row] = await services.db.select().from(connections).where(eq(connections.id, id));
  if (!row) throw notFound('Connection');
  return row;
}

/**
 * Stores what Google's callback brought: a new connection, or the account's existing Google connection
 * updated (one per account and provider). Reconnecting the same Google account adds services; another
 * Google account replaces the old one, whose grant is revoked. Services are the asked-for ones Google granted (people can untick
 * services on Google's consent screen).
 */
export async function storeGoogleConnection(
  services: Services,
  input: {
    accountId: string;
    provider?: ConnectorProvider;
    requested: readonly ConnectorService[];
    tokens: GoogleTokens & { refreshToken: string };
    user: GoogleUserInfo;
  },
): Promise<ConnectionRow> {
  const { accountId, tokens, user, provider = 'google' } = input;
  const now = services.clock();
  const [existing] = await services.db
    .select()
    .from(connections)
    .where(and(eq(connections.accountId, accountId), eq(connections.provider, provider)));
  const sameAccount = existing?.externalId === user.sub;
  const granted = (provider === 'google' ? googleServicesGranted : microsoftServicesGranted)(tokens.scopes);
  const wanted = new Set<ConnectorService>([
    ...input.requested,
    ...(sameAccount ? (existing?.services ?? []) : []),
  ]);
  const connected = granted.filter((s) => wanted.has(s));
  const id = existing?.id ?? newId('connection');
  const values = {
    externalId: user.sub,
    email: user.email,
    name: user.name,
    services: connected,
    scopes: tokens.scopes,
    refreshTokenEnc: sealConnectionToken(services.custody, id, 'refresh', tokens.refreshToken),
    accessTokenEnc: sealConnectionToken(services.custody, id, 'access', tokens.accessToken),
    accessExpiresAt: tokens.expiresAt,
    grantedAt: now,
    status: 'active' as const,
    reauthReason: null,
    checks: [],
    checkedAt: null,
    updatedAt: now,
  };
  const stored = await services.pipeline.transactAccount(async (tx) => {
    // A new connector connection: not while the licence is lapsed, and within the plan's connectors,
    // counted under the count's lock. Reconnecting the account's existing Google connection adds none.
    if (!existing) await services.licence.assertCanAdd('connectors', lockedConnectorCount(tx));
    const [row] = existing
      ? await tx.update(connections).set(values).where(eq(connections.id, id)).returning()
      : await tx
          .insert(connections)
          .values({ id, accountId, provider, createdAt: now, ...values })
          .returning();
    if (!row) throw new Error('connection upsert failed');
    return row;
  });
  // Another Google account replaced this one: its grant would stay live at Google with nothing here left to
  // revoke it, so revoke it now (IN-23), best effort like a disconnect.
  if (existing && !sameAccount) await revokeGrant(services, existing);
  return stored;
}

/** Revokes a connection's refresh token at Google; best effort (a failure or a timeout is only logged). */
async function revokeGrant(services: Services, row: ConnectionRow): Promise<void> {
  // Only Google's grant is revoked; an IMAP account has no grant (its password is just forgotten with the row).
  if (row.provider !== 'google') return;
  try {
    const refresh = openConnectionToken(services.custody, row.id, 'refresh', row.refreshTokenEnc);
    // Irreversible (command-safety.md CS-01): a disconnect records it, whatever happens to its session.
    if (services.google.mode !== 'off')
      await externalEffect('google.revoke', () => providerOAuth(services, row.provider).revoke(refresh));
  } catch (err) {
    services.log.warn({ connectionId: row.id, err: String(err) }, 'could not revoke the Google token');
  }
}

/**
 * The connection needs its person to connect again (the tokens are no good any more). `grant`: only while the
 * row still holds this sealed refresh token (a reconnect meanwhile brought a new grant, IN-22). Returns
 * whether the row was marked.
 */
export async function markNeedsReauth(
  services: Services,
  id: string,
  reason: ReauthReason,
  grant?: { refreshTokenEnc: string },
): Promise<boolean> {
  const now = services.clock();
  const marked = await services.pipeline.transactAccount(async (tx) =>
    tx
      .update(connections)
      .set({
        status: 'needs_reauth',
        reauthReason: reason,
        accessTokenEnc: null,
        accessExpiresAt: null,
        updatedAt: now,
      })
      .where(
        grant
          ? and(eq(connections.id, id), eq(connections.refreshTokenEnc, grant.refreshTokenEnc))
          : eq(connections.id, id),
      )
      .returning({ id: connections.id }),
  );
  if (marked.length) {
    services.log.info({ connectionId: id, reason }, 'connection needs reauth');
    // The person hears it from their assistant (AG-13), in the background: this may run inside a burrow's commit
    // (a tool's token refresh), whose lock the repair message would wait for.
    services.guides.needsReauth(id);
  }
  return marked.length > 0;
}

/**
 * Runs the service checks (CN-06) and stores them. A connection that cannot get a token keeps its checks
 * (it shows why it needs reauth instead).
 */
export async function checkConnection(services: Services, row: ConnectionRow): Promise<ConnectionRow> {
  let token: string;
  try {
    token = await services.google.tokens.accessFor(row.accountId, row.provider);
  } catch (err) {
    if (err instanceof ConnectionUnavailableError) return connectionById(services, row.id);
    services.log.warn({ connectionId: row.id, err: String(err) }, 'connection check: no access token');
    return saveChecks(
      services,
      row.id,
      row.services.map((service) => ({
        service,
        state: 'error' as const,
        message: 'Couldn’t reach Google. Try again in a moment.',
      })),
    );
  }
  const fresh = await connectionById(services, row.id);
  const checks =
    row.provider === 'google'
      ? await runGoogleChecks(services.google.mode, token, fresh.services, fresh.scopes)
      : await Promise.all(
          fresh.services.map((s) =>
            providerWorkspace(services, row.provider).checkService(token, s, fresh.scopes),
          ),
        );
  return saveChecks(services, row.id, checks);
}

async function saveChecks(
  services: Services,
  id: string,
  checks: ConnectionRow['checks'],
): Promise<ConnectionRow> {
  return services.pipeline.transactAccount(async (tx) => {
    const [row] = await tx
      .update(connections)
      .set({ checks, checkedAt: services.clock(), updatedAt: services.clock() })
      .where(eq(connections.id, id))
      .returning();
    if (!row) throw notFound('Connection');
    return row;
  });
}

/**
 * Disconnect: revoke the refresh token at Google (best effort: a failure or a timeout does not keep the
 * connection) and forget the row.
 */
export async function removeConnection(services: Services, row: ConnectionRow): Promise<void> {
  await revokeGrant(services, row);
  await services.pipeline.transactAccount(async (tx) => {
    await tx.delete(connections).where(eq(connections.id, row.id));
  });
}
