/**
 * Test helpers for catalog connections (docs/decisions/connections-catalog.md): a connection row stored the way the
 * connect side stores one — the token sealed with AAD `catalog_connection:<id>:secret`, OAuth tokens with `:access` /
 * `:refresh` (`connections/crypto.ts`) — without its routes, so the tools side is tested on its own; and the two
 * catalog keys for an agent.
 */
import {
  type ConnectionTransport,
  catalogEntry,
  connectionTransport,
  newId,
  resolveBaseUrl,
  type SignInKind,
  type Tier,
  type TokenAuth,
} from '@whombat/core';
import { type ConnectionSecretKind, sealConnectionSecret } from '../connections/crypto';
import { catalogConnections } from '../db/schema/index';
import type { Services } from '../services';
import { setGrant } from './approvals';

export interface TestConnection {
  catalogId: string;
  /** The burrow it belongs to. */
  burrowId: string;
  /** Who connected it (a person principal); default nobody. */
  connectedById?: string | null;
  label?: string;
  handle?: string;
  fields?: Record<string, string>;
  signIn?: SignInKind;
  auth?: TokenAuth | null;
  secret?: string | null;
  accessToken?: string | null;
  accessExpiresAt?: Date | null;
  refreshToken?: string | null;
  status?: 'active' | 'needs_reauth' | 'error';
  transport?: ConnectionTransport;
  /** MCP authorization: the authorization server, the client id and the resource (as the connect side stores them). */
  issuer?: string | null;
  clientId?: string | null;
  resource?: string | null;
}

/** Inserts a connection directly (the connect side's store isn't needed); returns its id. */
export async function insertConnection(services: Services, c: TestConnection): Promise<string> {
  const entry = catalogEntry(c.catalogId);
  if (!entry) throw new Error(`no catalog entry ${c.catalogId}`);
  const id = newId('connection');
  const signIn = c.signIn ?? 'token';
  // A report tracker names its driver: the tests' fake one unless a test says otherwise.
  const fields =
    c.catalogId === 'tracker' ? { driver: 'fake-tracker', ...(c.fields ?? {}) } : (c.fields ?? {});
  const baseUrl = resolveBaseUrl(entry, fields);
  if (!baseUrl) throw new Error(`no base URL for ${c.catalogId} with ${JSON.stringify(fields)}`);
  const seal = (kind: ConnectionSecretKind, value: string | null | undefined) =>
    value ? sealConnectionSecret(services.custody, id, kind, value) : null;
  await services.db.insert(catalogConnections).values({
    id,
    catalogId: c.catalogId,
    burrowId: c.burrowId,
    connectedById: c.connectedById ?? null,
    label: c.label ?? entry.name,
    handle: c.handle ?? entry.handle,
    transport: c.transport ?? connectionTransport(entry, signIn),
    signIn,
    baseUrl,
    fields,
    auth: c.auth === undefined ? (signIn === 'token' ? { type: 'bearer' } : null) : c.auth,
    secretEnc: seal('secret', c.secret),
    accessTokenEnc: seal('access', c.accessToken),
    accessExpiresAt: c.accessExpiresAt ?? null,
    refreshTokenEnc: seal('refresh', c.refreshToken),
    status: c.status ?? 'active',
    issuer: c.issuer ?? null,
    clientId: c.clientId ?? null,
    resource: c.resource ?? null,
    createdAt: services.clock(),
    updatedAt: services.clock(),
  });
  return id;
}

/** Sets an agent's two catalog keys (`connections.read`, `connections.write`). */
export async function setConnectionKeys(
  services: Services,
  agentId: string,
  tiers: { read: Tier; write: Tier },
): Promise<void> {
  await setGrant(services, agentId, 'connections.read', tiers.read);
  await setGrant(services, agentId, 'connections.write', tiers.write);
}
