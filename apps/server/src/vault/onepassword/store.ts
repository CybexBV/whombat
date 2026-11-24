/**
 * Reading the 1Password sync's rows (docs/decisions/onepassword-sync.md): the burrow's 1Password
 * connection, its links and state, the connection page's part and each Vault entry's `source`. Nothing here calls
 * 1Password or returns a value: the page and Home read what the last pass stored.
 */
import {
  ONEPASSWORD_NOT_IN_VAULT_MAX,
  ONEPASSWORD_WORDS,
  type OnePasswordSyncView,
  onePasswordEntryEligible,
  type VaultAuth,
  type VaultEntrySource,
} from '@whombat/core';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { openConnectionSecret } from '../../connections/crypto';
import type { CatalogConnectionRow } from '../../connections/types';
import type { Db, Tx } from '../../db/client';
import {
  catalogConnections,
  type OnePasswordNotInVaultRow,
  vaultEntries,
  vaultOnePasswordLinks,
  vaultOnePasswordState,
} from '../../db/schema/index';
import { isoOrNull } from '../../lib/time';
import type { Services } from '../../services';
import type { VaultEntryRow } from '../store';
import { ONEPASSWORD_FAILING_AFTER } from './words';

export type OnePasswordLinkRow = typeof vaultOnePasswordLinks.$inferSelect;
export type OnePasswordStateRow = typeof vaultOnePasswordState.$inferSelect;

/** The catalog id of 1Password's entry. */
export const ONEPASSWORD_CATALOG_ID = 'onepassword';

/** A second 1Password connection, refused. */
export const ONEPASSWORD_CONNECTION_EXISTS =
  'This Whombat already keeps its Vault in step with 1Password. Remove that connection first.';

/** The burrow's 1Password connection (at most one), or null. */
export async function onePasswordConnectionOf(
  db: Db | Tx,
  burrowId: string,
): Promise<CatalogConnectionRow | null> {
  const [row] = await db
    .select()
    .from(catalogConnections)
    .where(
      and(
        eq(catalogConnections.burrowId, burrowId),
        eq(catalogConnections.catalogId, ONEPASSWORD_CATALOG_ID),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Every 1Password connection of this install (an appliance has one burrow, so at most one). */
export async function onePasswordConnections(db: Db | Tx): Promise<CatalogConnectionRow[]> {
  return db.select().from(catalogConnections).where(eq(catalogConnections.catalogId, ONEPASSWORD_CATALOG_ID));
}

/** The service account token, opened (the server's and the worker's only). Null when the connection has none. */
export function onePasswordToken(
  services: Pick<Services, 'custody'>,
  row: CatalogConnectionRow,
): string | null {
  return row.secretEnc ? openConnectionSecret(services.custody, row.id, 'secret', row.secretEnc) : null;
}

/** The vault the connection keeps in step (its `vault` field). */
export function onePasswordVaultId(row: Pick<CatalogConnectionRow, 'fields'>): string | null {
  const id = (row.fields as Record<string, string> | null)?.vault?.trim();
  return id ? id : null;
}

export async function onePasswordState(
  db: Db | Tx,
  connectionId: string,
): Promise<OnePasswordStateRow | null> {
  const [row] = await db
    .select()
    .from(vaultOnePasswordState)
    .where(eq(vaultOnePasswordState.connectionId, connectionId));
  return row ?? null;
}

export async function onePasswordLinks(db: Db | Tx, connectionId: string): Promise<OnePasswordLinkRow[]> {
  return db.select().from(vaultOnePasswordLinks).where(eq(vaultOnePasswordLinks.connectionId, connectionId));
}

/** A link as it is now, or null when it is gone. */
export async function onePasswordLink(db: Db | Tx, linkId: string): Promise<OnePasswordLinkRow | null> {
  const [row] = await db.select().from(vaultOnePasswordLinks).where(eq(vaultOnePasswordLinks.id, linkId));
  return row ?? null;
}

/** Whether an entry row syncs by its kind and sign-in (a website login, an API token with bearer or basic). */
export function entryEligible(row: Pick<VaultEntryRow, 'kind' | 'auth'>): boolean {
  return onePasswordEntryEligible({ kind: row.kind, auth: row.auth as VaultAuth | null });
}

/* The connection page's part ----------------------------------------------------------------------- */

/**
 * “Not in your Vault” as the page shows it: without the time each item was read at, and without an item that didn't read
 * only once (usually a blip) or whose entry is in the Vault (its entry's page says so).
 */
function notInVaultView(
  rows: readonly OnePasswordNotInVaultRow[],
  pairedItems: ReadonlySet<string>,
): OnePasswordSyncView['notInVault'] {
  return rows
    .filter((r) => !pairedItems.has(r.itemId) && (r.reason !== 'unreadable' || (r.failedReads ?? 0) >= 2))
    .slice(0, ONEPASSWORD_NOT_IN_VAULT_MAX)
    .map((r) => ({ itemId: r.itemId, title: r.title.slice(0, 200), reason: r.reason }));
}

/** The connection page's 1Password part (`connections.onePassword`): the last pass's state and the counts now. */
export async function onePasswordSyncView(
  db: Db | Tx,
  connection: CatalogConnectionRow,
  syncing: boolean,
): Promise<OnePasswordSyncView> {
  const [state, links, entries] = await Promise.all([
    onePasswordState(db, connection.id),
    onePasswordLinks(db, connection.id),
    db
      .select({ id: vaultEntries.id, kind: vaultEntries.kind, auth: vaultEntries.auth })
      .from(vaultEntries)
      .where(eq(vaultEntries.burrowId, connection.burrowId)),
  ]);
  const linked = new Set(links.map((l) => l.entryId).filter((id): id is string => id !== null));
  const withEntry = links.filter((l) => l.entryId !== null);
  const unlinked = entries.filter((e) => !linked.has(e.id) && entryEligible(e)).length;
  const outcome = state?.outcome ?? null;
  return {
    connectionId: connection.id,
    vaultTitle: state?.vaultTitle ?? null,
    kept: withEntry.filter((l) => l.state === 'synced').length,
    // A new entry 1Password refused doesn't wait: it goes again when it changes.
    pending: withEntry.filter((l) => l.state === 'creating' && l.refused === null).length + unlinked,
    localOnly: withEntry.filter((l) => l.state === 'local_only').length,
    checkedAt: isoOrNull(state?.checkedAt ?? null),
    outcome,
    problem: outcome === 'failing' ? (state?.problem ?? ONEPASSWORD_WORDS.unreachable) : null,
    nextTryAt: outcome === 'waiting' ? isoOrNull(state?.nextTryAt ?? null) : null,
    failing: outcome === 'failing' && (state?.failures ?? 0) >= ONEPASSWORD_FAILING_AFTER,
    readOnly: state?.readOnly ?? false,
    syncing,
    notInVault: notInVaultView(
      state?.notInVault ?? [],
      new Set(withEntry.flatMap((l) => (l.itemId ? [l.itemId] : []))),
    ),
    removals: state?.removals ?? null,
  };
}

/* Each entry's source -------------------------------------------------------------------------------- */

/**
 * Where else each entry is kept in step (`VaultEntry.source`): a pair's state and words, “Waiting to go to 1Password”
 * for an eligible entry the next pass will put in, nothing for an entry kept only in Whombat. Empty without a 1Password
 * connection.
 */
export async function entrySources(
  db: Db | Tx,
  rows: readonly VaultEntryRow[],
): Promise<Map<string, VaultEntrySource>> {
  const out = new Map<string, VaultEntrySource>();
  const burrowIds = [...new Set(rows.map((r) => r.burrowId))];
  if (!rows.length || !burrowIds.length) return out;
  const connections = await db
    .select({ id: catalogConnections.id, burrowId: catalogConnections.burrowId })
    .from(catalogConnections)
    .where(
      and(
        inArray(catalogConnections.burrowId, burrowIds),
        eq(catalogConnections.catalogId, ONEPASSWORD_CATALOG_ID),
      ),
    );
  if (!connections.length) return out;
  const [links, states] = await Promise.all([
    db
      .select()
      .from(vaultOnePasswordLinks)
      .where(
        and(
          isNotNull(vaultOnePasswordLinks.entryId),
          inArray(
            vaultOnePasswordLinks.entryId,
            rows.map((r) => r.id),
          ),
        ),
      ),
    db
      .select({ connectionId: vaultOnePasswordState.connectionId, readOnly: vaultOnePasswordState.readOnly })
      .from(vaultOnePasswordState)
      .where(
        inArray(
          vaultOnePasswordState.connectionId,
          connections.map((c) => c.id),
        ),
      ),
  ]);
  const byEntry = new Map(links.map((l) => [l.entryId as string, l]));
  const connectionOf = new Map(connections.map((c) => [c.burrowId, c.id]));
  const readOnly = new Set(states.filter((s) => s.readOnly).map((s) => s.connectionId));
  for (const row of rows) {
    const link = byEntry.get(row.id);
    const syncedAt = isoOrNull(link?.syncedAt ?? null);
    if (link) {
      // Paired with an item now: removing the entry archives that item.
      const paired = link.state === 'synced' && link.itemId !== null;
      if (link.problem)
        out.set(row.id, { kind: 'onepassword', state: 'problem', syncedAt, problem: link.problem, paired });
      else if (link.state === 'creating')
        out.set(row.id, { kind: 'onepassword', state: 'pending', syncedAt, paired });
      else if (link.state === 'synced')
        out.set(row.id, { kind: 'onepassword', state: 'synced', syncedAt, paired });
      continue;
    }
    const connectionId = connectionOf.get(row.burrowId);
    if (!connectionId || !entryEligible(row)) continue;
    out.set(
      row.id,
      readOnly.has(connectionId)
        ? {
            kind: 'onepassword',
            state: 'problem',
            syncedAt: null,
            problem: ONEPASSWORD_WORDS.readOnly,
            paired: false,
          }
        : { kind: 'onepassword', state: 'pending', syncedAt: null, paired: false },
    );
  }
  return out;
}
