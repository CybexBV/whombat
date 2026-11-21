/**
 * The records of the passkey backup keys (docs/decisions/backup-passkey.md): read anywhere, written only here, through
 * the commit pipeline. A key is sealed with key custody (AAD `backup_passkey_key:<appliance>:<credentialId>`) and opened
 * only to lock the backup details with it. Rows of another PeerId came with a backup of an earlier Whombat: never used.
 */
import { fromBase64url, KIT_KEY_BYTES, toBase64url } from '@whombat/core/backup';
import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import {
  type BackupKeyStateRow,
  type BackupPasskeyKeyRow,
  backupKeyState,
  backupPasskeyKeys,
} from '../db/schema/index';
import type { KeyCustody } from '../keys/custody';
import type { Services } from '../services';

export type { BackupKeyStateRow, BackupPasskeyKeyRow };

export const backupKeyAad = (appliance: string, credentialId: string) =>
  `backup_passkey_key:${appliance}:${credentialId}`;

/** The key sealed for its row. */
export function sealBackupKey(
  custody: KeyCustody,
  appliance: string,
  credentialId: string,
  key: Uint8Array,
): string {
  return custody.seal(backupKeyAad(appliance, credentialId), toBase64url(key));
}

/** The key of a row; null when it can't be opened (another master key, a damaged row). */
export function openBackupKey(custody: KeyCustody, row: BackupPasskeyKeyRow): Uint8Array | null {
  try {
    const key = fromBase64url(custody.open(backupKeyAad(row.appliance, row.credentialId), row.keySealed));
    return key && key.length === KIT_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

/** This Whombat's keys, oldest first. */
export async function loadBackupKeys(db: Db | Tx, appliance: string): Promise<BackupPasskeyKeyRow[]> {
  return db
    .select()
    .from(backupPasskeyKeys)
    .where(eq(backupPasskeyKeys.appliance, appliance))
    .orderBy(backupPasskeyKeys.createdAt);
}

export async function loadBackupKeyState(db: Db | Tx, appliance: string): Promise<BackupKeyStateRow | null> {
  const [row] = await db.select().from(backupKeyState).where(eq(backupKeyState.appliance, appliance));
  return row ?? null;
}

type KeyFields = Pick<BackupPasskeyKeyRow, 'accountId' | 'salt' | 'keySealed'>;

/**
 * Keeps a passkey's key (a new one, or the same passkey again: its key and salt replaced). A changed key loses the
 * envelope locked with the old one, so the details are locked again.
 */
export async function saveBackupKey(
  tx: Tx,
  appliance: string,
  credentialId: string,
  fields: KeyFields,
  at: Date,
): Promise<void> {
  await tx
    .insert(backupPasskeyKeys)
    .values({ appliance, credentialId, ...fields, createdAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: [backupPasskeyKeys.appliance, backupPasskeyKeys.credentialId],
      set: {
        ...fields,
        envelope: null,
        generation: null,
        lockedDigest: null,
        lockedAt: null,
        storedAt: null,
        verifiedAt: null,
        updatedAt: at,
      },
    });
}

/** Removes the keys of a passkey (of every Whombat's rows: the passkey is gone). How many went. */
export async function removeBackupKeysOf(tx: Tx, credentialId: string, accountId?: string): Promise<number> {
  const gone = await tx
    .delete(backupPasskeyKeys)
    .where(
      accountId
        ? and(eq(backupPasskeyKeys.credentialId, credentialId), eq(backupPasskeyKeys.accountId, accountId))
        : eq(backupPasskeyKeys.credentialId, credentialId),
    )
    .returning({ id: backupPasskeyKeys.credentialId });
  return gone.length;
}

/** Removes every key of an account (its passkeys went with it). */
export async function removeBackupKeysOfAccount(tx: Tx, accountId: string): Promise<number> {
  const gone = await tx
    .delete(backupPasskeyKeys)
    .where(eq(backupPasskeyKeys.accountId, accountId))
    .returning({ id: backupPasskeyKeys.credentialId });
  return gone.length;
}

/** Changes fields of a key's row that is there. */
export async function updateBackupKey(
  services: Services,
  appliance: string,
  credentialId: string,
  change: Partial<
    Pick<BackupPasskeyKeyRow, 'envelope' | 'generation' | 'lockedDigest' | 'lockedAt' | 'storedAt'>
  >,
  /** Only while the row still holds this sealed key. */
  keySealed?: string,
): Promise<void> {
  await services.pipeline.transactAccount(async (tx) => {
    await tx
      .update(backupPasskeyKeys)
      .set({ ...change, updatedAt: services.clock() })
      .where(
        and(
          eq(backupPasskeyKeys.appliance, appliance),
          eq(backupPasskeyKeys.credentialId, credentialId),
          ...(keySealed ? [eq(backupPasskeyKeys.keySealed, keySealed)] : []),
        ),
      );
  });
}

export type KeyStateChange = Partial<Omit<BackupKeyStateRow, 'appliance' | 'updatedAt'>>;

/** Writes fields of this Whombat's state (the row made the first time). */
export async function updateBackupKeyState(
  services: Services,
  appliance: string,
  change: KeyStateChange,
): Promise<void> {
  await services.pipeline.transactAccount(async (tx) =>
    saveBackupKeyState(tx, appliance, change, services.clock()),
  );
}

export async function saveBackupKeyState(
  tx: Tx,
  appliance: string,
  change: KeyStateChange,
  at: Date,
): Promise<void> {
  await tx
    .insert(backupKeyState)
    .values({ appliance, ...change, updatedAt: at })
    .onConflictDoUpdate({ target: backupKeyState.appliance, set: { ...change, updatedAt: at } });
}
