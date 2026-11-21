/**
 * The Google OAuth client of this Whombat (docs/decisions/connectors.md CN-02): set by the person in Settings
 * (table `connector_apps`, the secret sealed with AAD `connector_app:google`), or in config
 * (`WHOMBAT_GOOGLE_CLIENT_ID` + `WHOMBAT_GOOGLE_CLIENT_SECRET`), which wins and makes the panel read-only.
 *
 * Instance-level writes (CN-07): account functions under the session's auth, through
 * `pipeline.transactAccount`, not a burrow's commit pipeline.
 */
import {
  type ConnectorAppStatus,
  type ConnectorProvider,
  clientIdHint,
  NEW_CLIENT_NEEDS_SECRET_TEXT,
  type SetGoogleAppBody,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { connections, connectorApps } from '../db/schema/index';
import { ApiError, conflict } from '../lib/errors';
import { iso } from '../lib/time';
import type { Services } from '../services';
import { openAppSecret, sealAppSecret } from './crypto';
import type { GoogleAppCredentials } from './types';

type AppRow = typeof connectorApps.$inferSelect;

/** The client set in config, or null. */
function configApp(services: Services, provider: ConnectorProvider = 'google'): GoogleAppCredentials | null {
  if (provider !== 'google') return null;
  const { WHOMBAT_GOOGLE_CLIENT_ID: clientId, WHOMBAT_GOOGLE_CLIENT_SECRET: clientSecret } = services.config;
  return clientId && clientSecret ? { clientId, clientSecret, userType: null, source: 'config' } : null;
}

async function appRow(services: Services, provider: ConnectorProvider = 'google'): Promise<AppRow | null> {
  const [row] = await services.db.select().from(connectorApps).where(eq(connectorApps.provider, provider));
  return row ?? null;
}

/** The client in use (config first, then Settings), with the secret opened; null when there is none. */
export async function googleAppCredentials(
  services: Services,
  provider: ConnectorProvider = 'google',
): Promise<GoogleAppCredentials | null> {
  const fromConfig = configApp(services, provider);
  if (fromConfig) return fromConfig;
  const row = await appRow(services, provider);
  if (!row) return null;
  return {
    clientId: row.clientId,
    clientSecret: openAppSecret(services.custody, provider, row.clientSecretEnc),
    userType: row.userType,
    source: 'settings',
  };
}

/** What clients may know about the app: never the secret. */
export async function googleAppStatus(
  services: Services,
  provider: ConnectorProvider = 'google',
): Promise<ConnectorAppStatus> {
  const fromConfig = configApp(services, provider);
  if (fromConfig)
    return {
      provider: provider,
      configured: true,
      source: 'config',
      clientIdHint: clientIdHint(fromConfig.clientId),
      secretSet: true,
      userType: null,
      updatedAt: null,
    };
  const row = await appRow(services, provider);
  return {
    provider: provider,
    configured: row !== null,
    source: row ? 'settings' : null,
    clientIdHint: row ? clientIdHint(row.clientId) : null,
    secretSet: row !== null,
    userType: row?.userType ?? null,
    updatedAt: row ? iso(row.updatedAt) : null,
  };
}

function refuseWhenInConfig(services: Services, provider: ConnectorProvider): void {
  if (configApp(services, provider))
    throw conflict(
      'Google is set in this Whombat’s config (WHOMBAT_GOOGLE_CLIENT_ID), so it can’t be changed here.',
    );
}

/** Every Google connection needs the person to connect again, with why (their tokens are useless now). */
async function reauthEveryConnection(tx: Tx, now: Date, provider: ConnectorProvider): Promise<string[]> {
  const marked = await tx
    .update(connections)
    .set({
      status: 'needs_reauth',
      reauthReason: 'app_removed',
      accessTokenEnc: null,
      accessExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(connections.provider, provider), eq(connections.status, 'active')))
    .returning({ id: connections.id });
  return marked.map((m) => m.id);
}

/**
 * Saves or replaces the client. The id and secret may be left out to keep the stored ones (changing the
 * audience); a new id needs its own secret.
 * A different client id means every connection's tokens belong to another client: they need reauth.
 */
export async function saveGoogleApp(
  services: Services,
  accountId: string,
  body: SetGoogleAppBody,
  provider: ConnectorProvider = 'google',
): Promise<void> {
  refuseWhenInConfig(services, provider);
  const existing = await appRow(services, provider);
  const clientId = body.clientId ?? existing?.clientId;
  if (!clientId)
    throw new ApiError('validation_failed', 'Paste the Client ID too.', {
      fields: { clientId: ['Paste the Client ID too.'] },
    });
  if (!existing && !body.clientSecret)
    throw new ApiError('validation_failed', 'Paste the client secret too.', {
      fields: { clientSecret: ['Paste the client secret too.'] },
    });
  // The stored secret is the old client's: kept with a new id, every sign-in would fail (IN-27).
  if (existing && existing.clientId !== clientId && !body.clientSecret)
    throw new ApiError('validation_failed', NEW_CLIENT_NEEDS_SECRET_TEXT, {
      fields: { clientSecret: [NEW_CLIENT_NEEDS_SECRET_TEXT] },
    });
  const now = services.clock();
  const secretEnc = body.clientSecret
    ? sealAppSecret(services.custody, provider, body.clientSecret)
    : (existing?.clientSecretEnc as string);
  const reauthed = await services.pipeline.transactAccount(async (tx) => {
    await tx
      .insert(connectorApps)
      .values({
        provider: provider,
        clientId,
        clientSecretEnc: secretEnc,
        userType: body.userType,
        updatedByAccountId: accountId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: connectorApps.provider,
        set: {
          clientId,
          clientSecretEnc: secretEnc,
          userType: body.userType,
          updatedByAccountId: accountId,
          updatedAt: now,
        },
      });
    return existing && existing.clientId !== clientId ? reauthEveryConnection(tx, now, provider) : [];
  });
  services.log.info({ accountId, provider: provider }, 'connector app saved');
  // In the person's Chat (assistant-guides.md AG-13): a repair message for connections of the replaced client.
  if (reauthed.length) services.guides.track('google repair', () => services.guides.repair(reauthed));
}

/** Removes the client: every Google connection needs to be connected again (reason `app_removed`). */
export async function removeGoogleApp(
  services: Services,
  accountId: string,
  provider: ConnectorProvider = 'google',
): Promise<void> {
  refuseWhenInConfig(services, provider);
  const now = services.clock();
  const reauthed = await services.pipeline.transactAccount(async (tx) => {
    await tx.delete(connectorApps).where(eq(connectorApps.provider, provider));
    return reauthEveryConnection(tx, now, provider);
  });
  services.log.info({ accountId, provider: provider }, 'connector app removed');
  // Everyone whose Google stopped working hears it from their assistant (AG-13).
  if (reauthed.length) services.guides.track('repair', () => services.guides.repair(reauthed));
}
