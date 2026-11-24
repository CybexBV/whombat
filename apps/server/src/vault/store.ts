/**
 * Reading the Vault (docs/decisions/vault.md VT-52, VT-70…VT-72): the person's entries and their views, and whether each
 * is switched on for the agent (docs/decisions/vault-simplify.md VLT-10). Nothing here ever returns a sealed value.
 */
import {
  VAULT_RECENT_USES,
  VAULT_SSH_PASSWORD_UNSET,
  type VaultAuth,
  type VaultEntry,
  type VaultEntryDetail,
  type VaultEntrySource,
  type VaultKeyView,
  type VaultNetwork,
  type VaultSshHostKey,
  type VaultSshServer,
  type VaultTool,
  type VaultUse,
  vaultSshEntryCheck,
} from '@whombat/core';
import { and, asc, count, desc, eq, inArray, isNotNull, type SQL, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import {
  accounts,
  burrows,
  principals,
  vaultEntries,
  vaultNetworks,
  vaultSshServers,
  vaultTools,
  vaultUses,
} from '../db/schema/index';
import { notFound } from '../lib/errors';
import { iso, isoOrNull } from '../lib/time';
import { loadAgentRow } from '../read/principals';
import type { Services } from '../services';
import { entrySources } from './onepassword/store';

export type VaultEntryRow = typeof vaultEntries.$inferSelect;
export type VaultToolRow = typeof vaultTools.$inferSelect;
export type VaultUseRow = typeof vaultUses.$inferSelect;
export type VaultNetworkRow = typeof vaultNetworks.$inferSelect;
export type VaultSshServerRow = typeof vaultSshServers.$inferSelect;

/** AAD binding an entry's sealed secret to its row: a copy in another row does not open (VT-04). */
export function vaultSecretAad(entryId: string): string {
  return `vault:${entryId}:secret`;
}

/** The AAD a login's authenticator key is sealed under (`vaultTotpCanonical` of it, VLT-46). */
export function vaultTotpAad(entryId: string): string {
  return `vault:${entryId}:totp`;
}

/** The AAD a server's kept password is sealed under: its key's entry and the server, so it opens nowhere else. */
export function vaultServerPasswordAad(entryId: string, serverId: string): string {
  return `vault:${entryId}:server:${serverId}:password`;
}

/** “Not found” for someone else's entry and a missing one alike (VT-81). */
export const entryNotFound = () => notFound('Vault entry');

/* The agent's switch (VLT-10) ---------------------------------------------------------------------- */

/** The agent's key to an entry as its switch reads: when it was switched on, an SSH key's servers, an API's variable. */
export interface AgentKey {
  onAt: Date;
  /** An `ssh` entry: the servers it covers, null for All servers; null for the other kinds. */
  servers: string[] | null;
  /** An `http` entry: its variable in the agent's commands (null until one is set); null for the other kinds. */
  envName: string | null;
}

/** The entry's switch for the agent: null while it is off (a `secret` entry never is on). */
export function agentKeyOf(
  row: Pick<VaultEntryRow, 'kind' | 'agentOnAt' | 'agentServers' | 'envName'>,
): AgentKey | null {
  if (!row.agentOnAt || row.kind === 'secret') return null;
  return {
    onAt: row.agentOnAt,
    servers: row.kind === 'ssh' ? (row.agentServers ?? null) : null,
    envName: row.kind === 'http' ? row.envName : null,
  };
}

/** The entry's switch, when `agentId` is its burrow's agent (Whombat's other signers never hold one). */
export async function agentKeyFor(
  db: Db | Tx,
  entry: Pick<VaultEntryRow, 'burrowId' | 'kind' | 'agentOnAt' | 'agentServers' | 'envName'>,
  agentId: string,
): Promise<AgentKey | null> {
  const key = agentKeyOf(entry);
  if (!key) return null;
  return (await loadAgentRow(db, entry.burrowId))?.id === agentId ? key : null;
}

/** Entries switched on for `agentId`: on, and in the burrow it is the agent of. */
export function onForAgent(agentId: string): SQL {
  return and(
    isNotNull(vaultEntries.agentOnAt),
    sql`${vaultEntries.burrowId} = (select ${principals.burrowId} from ${principals} where ${principals.id} = ${agentId} and ${principals.kind} = 'agent')`,
  ) as SQL;
}

/** The person's entry in this burrow, or 404. */
export async function ownEntry(
  db: Db | Tx,
  burrowId: string,
  ownerId: string,
  entryId: string,
): Promise<VaultEntryRow> {
  const [row] = await db
    .select()
    .from(vaultEntries)
    .where(
      and(
        eq(vaultEntries.id, entryId),
        eq(vaultEntries.burrowId, burrowId),
        eq(vaultEntries.ownerId, ownerId),
      ),
    );
  if (!row) throw entryNotFound();
  return row;
}

export async function entryById(db: Db | Tx, entryId: string): Promise<VaultEntryRow | undefined> {
  const [row] = await db.select().from(vaultEntries).where(eq(vaultEntries.id, entryId));
  return row;
}

/** The person's entries in a burrow (by name). */
export async function entriesOf(db: Db | Tx, burrowId: string, ownerId: string): Promise<VaultEntryRow[]> {
  return db
    .select()
    .from(vaultEntries)
    .where(and(eq(vaultEntries.burrowId, burrowId), eq(vaultEntries.ownerId, ownerId)))
    .orderBy(asc(sql`lower(${vaultEntries.name})`), asc(vaultEntries.createdAt));
}

export async function entryCount(db: Db | Tx, burrowId: string, ownerId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(vaultEntries)
    .where(and(eq(vaultEntries.burrowId, burrowId), eq(vaultEntries.ownerId, ownerId)));
  return row?.n ?? 0;
}

function toEntry(
  row: VaultEntryRow,
  servers: readonly VaultSshServer[],
  source: VaultEntrySource | undefined,
): VaultEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    url: row.kind === 'secret' || row.kind === 'ssh' ? null : row.url,
    auth: row.kind === 'secret' ? null : (row.auth as VaultAuth | null),
    secret: { set: row.sealed !== null, setAt: row.sealed !== null ? isoOrNull(row.secretSetAt) : null },
    // A login's authenticator key (VLT-46): whether one is sealed, never the key.
    totp:
      row.kind === 'login' && row.totpSealed !== null
        ? { set: true, setAt: isoOrNull(row.totpSetAt ?? row.secretSetAt) }
        : { set: false, setAt: null },
    // An SSH key's dot and line are its servers' checks taken together (VT-S05, core `vaultSshEntryCheck`).
    check:
      row.kind === 'ssh'
        ? vaultSshEntryCheck(servers)
        : {
            status: row.checkStatus,
            summary: row.checkSummary,
            checkedAt: isoOrNull(row.checkedAt),
            toolCount: row.kind === 'mcp' ? row.toolCount : null,
          },
    agentOn: agentKeyOf(row) !== null,
    serverCount: row.kind === 'ssh' ? servers.length : 0,
    // An `mcp` entry still here is one the start-up move couldn't take to Connections (VLT-30).
    moveToConnections: row.kind === 'mcp',
    // Kept in step with a linked 1Password vault (onepassword-sync.md): its tag and its page's line.
    ...(source ? { source } : {}),
    lastUsedAt: isoOrNull(row.lastUsedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/* SSH servers (VT-S04, VT-S05) ------------------------------------------------------------------ */

/** The servers of these `ssh` entries, by name. */
export async function serverRows(db: Db | Tx, entryIds: readonly string[]): Promise<VaultSshServerRow[]> {
  if (!entryIds.length) return [];
  return db
    .select()
    .from(vaultSshServers)
    .where(inArray(vaultSshServers.entryId, [...entryIds]))
    .orderBy(asc(vaultSshServers.name));
}

/** One of an entry's servers, or null. */
export async function serverRow(
  db: Db | Tx,
  entryId: string,
  serverId: string,
): Promise<VaultSshServerRow | null> {
  const [row] = await db
    .select()
    .from(vaultSshServers)
    .where(and(eq(vaultSshServers.entryId, entryId), eq(vaultSshServers.id, serverId)));
  return row ?? null;
}

/** A server as the person sees it: the pinned key, the key last seen that isn't trusted, the check. */
export function toServer(row: VaultSshServerRow): VaultSshServer {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    // Production servers (one-person.md OP-07): closed to the agent's commands until the person says yes.
    production: row.production,
    // A server's kept password (VLT-42): whether one is sealed with it, never the value.
    password:
      row.passwordSealed !== null
        ? { set: true, setAt: isoOrNull(row.passwordSetAt) }
        : { ...VAULT_SSH_PASSWORD_UNSET },
    hostKey:
      row.hostKeyAlgorithm && row.hostKeyFingerprint && row.hostKeyTrustedAt
        ? {
            algorithm: row.hostKeyAlgorithm,
            fingerprint: row.hostKeyFingerprint,
            trustedAt: iso(row.hostKeyTrustedAt),
          }
        : null,
    seenHostKey:
      row.seenHostKeyAlgorithm && row.seenHostKeyFingerprint && row.seenHostKeyAt
        ? {
            algorithm: row.seenHostKeyAlgorithm,
            fingerprint: row.seenHostKeyFingerprint,
            seenAt: iso(row.seenHostKeyAt),
          }
        : null,
    check: {
      status: row.checkStatus,
      outcome: row.checkOutcome,
      summary: row.checkSummary,
      checkedAt: isoOrNull(row.checkedAt),
    },
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** YOUR ENTRIES (VT-70). */
export async function entryViews(db: Db | Tx, rows: readonly VaultEntryRow[]): Promise<VaultEntry[]> {
  const sshIds = rows.filter((r) => r.kind === 'ssh').map((r) => r.id);
  const [servers, sources] = await Promise.all([serverRows(db, sshIds), entrySources(db, rows)]);
  return rows.map((r) =>
    toEntry(r, servers.filter((s) => s.entryId === r.id).map(toServer), sources.get(r.id)),
  );
}

export function toTool(row: VaultToolRow): VaultTool {
  return {
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    isNew: row.isNew,
    hash: row.hash,
  };
}

export async function toolRows(db: Db | Tx, entryId: string): Promise<VaultToolRow[]> {
  return db
    .select()
    .from(vaultTools)
    .where(eq(vaultTools.entryId, entryId))
    .orderBy(asc(vaultTools.position));
}

export function toUse(row: VaultUseRow): VaultUse {
  return {
    id: row.id,
    entryId: row.entryId,
    agentId: row.agentId,
    requesterId: row.requesterId,
    dispatchId: row.dispatchId,
    what: row.what,
    outcome: row.outcome,
    at: iso(row.at),
    eventId: row.eventId,
  };
}

/** RECENT USE, newest first (`before`: a use id to page from). */
export async function usesOf(
  db: Db | Tx,
  entryId: string,
  options: { limit: number; before?: string | undefined },
): Promise<{ uses: VaultUse[]; before: string | null; hasMore: boolean }> {
  const where = [eq(vaultUses.entryId, entryId)];
  if (options.before) {
    const [from] = await db
      .select({ at: vaultUses.at, id: vaultUses.id })
      .from(vaultUses)
      .where(and(eq(vaultUses.id, options.before), eq(vaultUses.entryId, entryId)));
    if (from)
      where.push(
        sql`(${vaultUses.at}, ${vaultUses.id}) < (${from.at.toISOString()}::timestamptz, ${from.id})`,
      );
  }
  const rows = await db
    .select()
    .from(vaultUses)
    .where(and(...where))
    .orderBy(desc(vaultUses.at), desc(vaultUses.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const hasMore = rows.length > options.limit;
  return { uses: page.map(toUse), before: hasMore ? (page.at(-1)?.id ?? null) : null, hasMore };
}

/** An entry with everything the person manages on it (VT-71). */
export async function entryDetail(db: Db | Tx, row: VaultEntryRow): Promise<VaultEntryDetail> {
  const [[view], tools, recent, servers] = await Promise.all([
    entryViews(db, [row]),
    row.kind === 'mcp' ? toolRows(db, row.id) : Promise.resolve([]),
    usesOf(db, row.id, { limit: VAULT_RECENT_USES }),
    row.kind === 'ssh' ? serverRows(db, [row.id]) : Promise.resolve([]),
  ]);
  if (!view) throw entryNotFound();
  return {
    ...view,
    tools: tools.map(toTool),
    toolsIgnored: row.kind === 'mcp' ? row.toolsIgnored : 0,
    // The agent's key is the entry's switch: null while it is off (VLT-10).
    key: ((k): VaultKeyView | null =>
      k ? { givenAt: iso(k.onAt), servers: k.servers, envName: k.envName } : null)(agentKeyOf(row)),
    recentUses: recent.uses,
    servers: servers.map(toServer),
  };
}

/**
 * The host keys the person's Vault trusts for a host and port (server-signin.md SI-04, vault-self-serve.md VS-10): every
 * pinned key of a server of theirs at that address, whichever entry it is on. First contact with a server takes the key
 * it shows only when there is none; otherwise the key must be one of these.
 */
export async function vaultPins(
  db: Db | Tx,
  burrowId: string,
  ownerId: string,
  host: string,
  port: number,
): Promise<VaultSshHostKey[]> {
  const rows = await db
    .select({
      algorithm: vaultSshServers.hostKeyAlgorithm,
      fingerprint: vaultSshServers.hostKeyFingerprint,
      trustedAt: vaultSshServers.hostKeyTrustedAt,
    })
    .from(vaultSshServers)
    .innerJoin(vaultEntries, eq(vaultEntries.id, vaultSshServers.entryId))
    .where(
      and(
        eq(vaultSshServers.burrowId, burrowId),
        eq(vaultEntries.ownerId, ownerId),
        eq(vaultSshServers.port, port),
        sql`lower(${vaultSshServers.host}) = ${host.toLowerCase()}`,
      ),
    );
  return rows
    .filter((r) => r.algorithm && r.fingerprint && r.trustedAt)
    .map((r) => ({ algorithm: r.algorithm as string, fingerprint: r.fingerprint as string }));
}

/**
 * The person's Vault SSH servers that pin a key for this host and port (connect-in-chat.md): what Add a server's
 * “Trust the new one” trusts again, one by one, through the Vault's own Trust this server.
 */
export async function vaultPinnedServers(
  db: Db | Tx,
  burrowId: string,
  ownerId: string,
  host: string,
  port: number,
): Promise<{ entryId: string; serverId: string }[]> {
  const rows = await db
    .select({
      entryId: vaultSshServers.entryId,
      serverId: vaultSshServers.id,
      fingerprint: vaultSshServers.hostKeyFingerprint,
      trustedAt: vaultSshServers.hostKeyTrustedAt,
    })
    .from(vaultSshServers)
    .innerJoin(vaultEntries, eq(vaultEntries.id, vaultSshServers.entryId))
    .where(
      and(
        eq(vaultSshServers.burrowId, burrowId),
        eq(vaultEntries.ownerId, ownerId),
        eq(vaultSshServers.port, port),
        sql`lower(${vaultSshServers.host}) = ${host.toLowerCase()}`,
      ),
    );
  return rows
    .filter((r) => r.fingerprint && r.trustedAt)
    .slice(0, 10)
    .map((r) => ({ entryId: r.entryId, serverId: r.serverId }));
}

/* The home network list (VT-12) ----------------------------------------------------------------- */

export async function networkRows(db: Db | Tx): Promise<VaultNetworkRow[]> {
  return db.select().from(vaultNetworks).orderBy(asc(vaultNetworks.cidr));
}

/** The list as the destination rules read it. */
export async function listedNetworks(db: Db | Tx): Promise<{ cidr: string; ports: number[] }[]> {
  return (await networkRows(db)).map((n) => ({ cidr: n.cidr, ports: n.ports }));
}

/**
 * Whether the local network is open to Whombat's own calls (docs/decisions/local-network.md LN-01…LN-04): the config
 * allows it (`WHOMBAT_LOCAL_NETWORK`, `on` by default) and no burrow switched “Agents may reach
 * your local network” off (an appliance holds one burrow; the list and this switch are the install's).
 */
export async function localNetworkOpen(services: Pick<Services, 'config' | 'db'>): Promise<boolean> {
  if (services.config.WHOMBAT_LOCAL_NETWORK === 'off') return false;
  const [closed] = await services.db
    .select({ id: burrows.id })
    .from(burrows)
    .where(eq(burrows.agentsReachLan, false))
    .limit(1);
  return !closed;
}

/** What the destination rules read: the home network list, and whether the whole local network is open (LN-01). */
export async function destinationReach(
  services: Pick<Services, 'config' | 'db'>,
): Promise<{ networks: { cidr: string; ports: number[] }[]; lan: boolean }> {
  const [networks, lan] = await Promise.all([listedNetworks(services.db), localNetworkOpen(services)]);
  return { networks, lan };
}

export async function networkViews(db: Db | Tx): Promise<VaultNetwork[]> {
  const rows = await networkRows(db);
  const accountIds = [...new Set(rows.map((r) => r.addedByAccountId).filter((x): x is string => !!x))];
  const names = accountIds.length
    ? await db
        .select({ id: accounts.id, name: accounts.name })
        .from(accounts)
        .where(inArray(accounts.id, accountIds))
    : [];
  const nameOf = new Map(names.map((a) => [a.id, a.name]));
  return rows.map((r) => ({
    id: r.id,
    cidr: r.cidr,
    ports: r.ports,
    note: r.note,
    addedBy: (r.addedByAccountId && nameOf.get(r.addedByAccountId)) || 'Someone',
    addedAt: iso(r.addedAt),
  }));
}
