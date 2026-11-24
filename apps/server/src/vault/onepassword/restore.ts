/**
 * Backups and the 1Password sync (docs/decisions/onepassword-sync.md OPW-42): a restored Vault is older than
 * 1Password, so it must never write old passwords over newer ones. A restored entry that was kept in step is paired with
 * its item again without a base, and a whole-box restore forgets every base: the next pass reads the items and
 * 1Password's version wins (where both already agree, only the base is renewed). An item that isn't in the vault any
 * more leaves its entry a Whombat entry like any other.
 */
import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '../../db/client';
import { vaultOnePasswordLinks, vaultOnePasswordState } from '../../db/schema/index';
import type { Services } from '../../services';
import { onePasswordConnectionOf, onePasswordVaultId } from './store';

/**
 * Pairs a restored entry with the item the backup names, with no base, in the restore's own transaction. Nothing when
 * this Whombat has no 1Password connection, or the item is another entry's already. The pass checks the item is still in
 * the vault (a restore never calls 1Password).
 */
export async function relinkOnePassword(
  tx: Db | Tx,
  burrowId: string,
  entryId: string,
  itemId: string,
): Promise<void> {
  const connection = await onePasswordConnectionOf(tx, burrowId);
  const vaultId = connection ? onePasswordVaultId(connection) : null;
  if (!connection || !vaultId) return;
  const now = new Date();
  const [own] = await tx
    .select()
    .from(vaultOnePasswordLinks)
    .where(eq(vaultOnePasswordLinks.entryId, entryId));
  if (own) {
    if (own.itemId === itemId)
      await tx
        .update(vaultOnePasswordLinks)
        .set({
          state: 'synced',
          base: null,
          itemVersion: null,
          itemUpdatedAt: null,
          problem: null,
          updatedAt: now,
        })
        .where(eq(vaultOnePasswordLinks.id, own.id));
    return;
  }
  const [taken] = await tx
    .select({ id: vaultOnePasswordLinks.id })
    .from(vaultOnePasswordLinks)
    .where(
      and(eq(vaultOnePasswordLinks.connectionId, connection.id), eq(vaultOnePasswordLinks.itemId, itemId)),
    );
  if (taken) return;
  await tx.insert(vaultOnePasswordLinks).values({
    id: `opl_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
    burrowId,
    connectionId: connection.id,
    entryId,
    vaultId,
    itemId,
    state: 'synced',
    itemVersion: null,
    itemUpdatedAt: null,
    base: null,
    nameShortened: false,
    problem: null,
    syncedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * After a whole-box restore (the database is the backup's): every link forgets its base and every state its vault's
 * version, so the next pass reads every item and 1Password's version wins. Run while the box is still quarantined, so
 * no pass runs before it.
 */
export async function forgetOnePasswordBases(services: Pick<Services, 'pipeline'>): Promise<void> {
  await services.pipeline.transactAccount(async (tx) => {
    await tx.update(vaultOnePasswordLinks).set({ base: null, itemVersion: null, itemUpdatedAt: null });
    await tx.update(vaultOnePasswordState).set({ contentVersion: null });
  });
}
