/**
 * What the person sets up for connections on this Whombat (CX-14, CX-41): the OAuth app of an `app_oauth` entry (Dropbox) in
 * `connector_apps` (provider = catalog id; the secret sealed with AAD `connector_app:<catalogId>`, empty for a PKCE
 * public client), and “Add this network” on the home-network list the Vault and Connections share (VT-12): the network,
 * or the port added to the listed network. Account-level writes (no burrow).
 */
import {
  type AllowConnectionNetworkBody,
  canonicalCidr,
  catalogEntry,
  catalogSignIn,
  NEW_CLIENT_NEEDS_SECRET_TEXT,
  newId,
  type SetConnectorAppBody,
  sortedPorts,
  topics,
  VAULT_LIMIT_MESSAGES,
  VAULT_NETWORKS_MAX,
  vaultNetworkProblem,
  vaultPortsProblem,
} from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { sealAppSecret } from '../connectors/crypto';
import { catalogConnections, connectorApps, principals, vaultNetworks } from '../db/schema/index';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { networksResponse, writeNetworksFile } from '../vault/networks';
import { markNeedsReauth } from './commands';
import { connectionError } from './errors';

function appEntry(catalogId: string) {
  const entry = catalogEntry(catalogId);
  const method = entry ? catalogSignIn(entry, 'app_oauth') : null;
  if (!entry || method?.kind !== 'app_oauth') throw connectionError('not_supported', { catalogId });
  return { entry, method };
}

/** Every connection that signed in with the entry's app needs connecting again (its tokens are another client's). */
async function reauthAppConnections(services: Services, catalogId: string): Promise<number> {
  const rows = await services.db
    .select()
    .from(catalogConnections)
    .where(
      and(
        eq(catalogConnections.catalogId, catalogId),
        eq(catalogConnections.signIn, 'app_oauth'),
        eq(catalogConnections.status, 'active'),
      ),
    );
  let n = 0;
  for (const row of rows)
    if (
      await markNeedsReauth(services, row, 'app_removed', { message: 'The app it signed in with changed.' })
    )
      n++;
  return n;
}

/** `connectors.setApp`: saves or replaces an `app_oauth` entry's app; a new client id needs connections signed in again. */
export async function saveCatalogApp(
  services: Services,
  account: { id: string },
  catalogId: string,
  body: z.output<typeof SetConnectorAppBody>,
): Promise<void> {
  const { method } = appEntry(catalogId);
  const [existing] = await services.db
    .select()
    .from(connectorApps)
    .where(eq(connectorApps.provider, catalogId as never));
  const clientId = body.clientId ?? existing?.clientId;
  if (!clientId)
    throw new ApiError('validation_failed', 'Paste the app key too.', {
      fields: { clientId: ['Paste the app key too.'] },
    });
  const replacing = existing && existing.clientId !== clientId;
  let secretEnc: string;
  if (body.clientSecret === null) {
    if (!method.clientSecretOptional)
      throw new ApiError('validation_failed', 'This app needs its secret.', {
        fields: { clientSecret: ['This app needs its secret.'] },
      });
    secretEnc = '';
  } else if (body.clientSecret !== undefined) {
    secretEnc = sealAppSecret(services.custody, catalogId, body.clientSecret);
  } else if (replacing && existing.clientSecretEnc) {
    // The stored secret is the old client's (IN-27).
    throw new ApiError('validation_failed', NEW_CLIENT_NEEDS_SECRET_TEXT, {
      fields: { clientSecret: [NEW_CLIENT_NEEDS_SECRET_TEXT] },
    });
  } else {
    secretEnc = existing?.clientSecretEnc ?? '';
    if (!secretEnc && !method.clientSecretOptional)
      throw new ApiError('validation_failed', 'Paste the app secret too.', {
        fields: { clientSecret: ['Paste the app secret too.'] },
      });
  }
  const now = services.clock();
  const values = {
    clientId,
    clientSecretEnc: secretEnc,
    userType: 'external' as const,
    updatedByAccountId: account.id,
    updatedAt: now,
  };
  await services.pipeline.transactAccount((tx) =>
    tx
      .insert(connectorApps)
      .values({ provider: catalogId as never, ...values })
      .onConflictDoUpdate({ target: connectorApps.provider, set: values }),
  );
  services.log.info({ accountId: account.id, catalogId }, 'catalog app saved');
  if (replacing) await reauthAppConnections(services, catalogId);
}

/** `connectors.removeApp`: every connection that signed in with it needs to be connected again (`app_removed`). */
export async function removeCatalogApp(
  services: Services,
  account: { id: string },
  catalogId: string,
): Promise<void> {
  appEntry(catalogId);
  await services.pipeline.transactAccount((tx) =>
    tx.delete(connectorApps).where(eq(connectorApps.provider, catalogId as never)),
  );
  services.log.info({ accountId: account.id, catalogId }, 'catalog app removed');
  await reauthAppConnections(services, catalogId);
}

/**
 * `connections.allowNetwork` (CX-41): adds the network with the port, or the port to the network already listed (the
 * Vault's own add refuses a listed network). The list is written to the appliance's file and open Vault pages refetch.
 */
export async function allowConnectionNetwork(
  services: Services,
  account: { id: string },
  body: z.output<typeof AllowConnectionNetworkBody>,
) {
  const fieldError = (field: string, message: string) =>
    new ApiError('validation_failed', message, { fields: { [field]: [message] } });
  const cidr = canonicalCidr(body.cidr);
  if (!cidr) throw fieldError('cidr', 'That isn’t a network. Write it like 192.168.1.0/24.');
  const problem = vaultNetworkProblem(cidr, [body.port]);
  if (problem) throw fieldError(problem.field, problem.message);
  await services.pipeline.transactAccount(async (tx, session) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('whombat/vault-networks'))`);
    const rows = await tx.select().from(vaultNetworks);
    const listed = rows.find((r) => r.cidr === cidr);
    if (listed) {
      if (listed.ports.includes(body.port)) return;
      const ports = sortedPorts([...listed.ports, body.port]);
      const portsProblem = vaultPortsProblem(ports);
      if (portsProblem) throw fieldError('port', portsProblem.message);
      await tx.update(vaultNetworks).set({ ports }).where(eq(vaultNetworks.id, listed.id));
    } else {
      if (rows.length >= VAULT_NETWORKS_MAX)
        throw new ApiError('conflict', VAULT_LIMIT_MESSAGES.networks, {
          details: { code: 'limit_reached', limit: 'networks', max: VAULT_NETWORKS_MAX } as never,
        });
      await tx.insert(vaultNetworks).values({
        id: newId('vaultNetwork'),
        cidr,
        ports: [body.port],
        note: body.note ?? 'Added for a connection',
        addedByAccountId: account.id,
        addedAt: services.clock(),
      });
    }
    const people = await tx
      .select({ id: principals.id })
      .from(principals)
      .where(eq(principals.kind, 'person'));
    for (const p of people) session.publish(topics.me(p.id), { type: 'vault.updated', entryId: null });
    session.after(async () => {
      await writeNetworksFile(services).catch((err: unknown) =>
        services.log.error({ err: String(err) }, 'could not write the Vault home network file'),
      );
    });
  });
  services.log.info({ cidr, port: body.port }, 'home network allowed for a connection');
  return networksResponse(services);
}
