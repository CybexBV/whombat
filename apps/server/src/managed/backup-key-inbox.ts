/**
 * The Inbox's one ask about the backups' key (docs/decisions/backup-passkey.md): while this Whombat has backups a new
 * one could open but none of the person's passkeys holds its backup key, one calm item asks for the touch. Its button,
 * “Touch my passkey”, opens This Whombat's backups with the passkey asked for at once (`BACKUP_PASSKEY_HREF`); the item
 * goes as soon as a passkey holds the key. It starts on: without it nothing brings the backups back if the box breaks,
 * and only the person can give the touch (watch-defaults.md).
 */
import type { NeedsYouItem } from '@whombat/core';
import { BACKUP_PASSKEY_HREF } from '@whombat/protocol/session';
import { addBackupAsk } from '../home/box-backup';
import type { SourceCtx } from '../home/registry';
import { loadPrincipalRow } from '../read/principals';
import { checkStartsOn, registerChecks } from '../things/quiet/defaults';
import { bringBackOf } from './backup-key';
import { boxBackupStatus } from './box-backup';

/** The check behind the item. */
export const BACKUP_PASSKEY_CHECK = 'backup.passkey';
registerChecks([
  // No passkey can bring the backups back: data at risk if the box breaks, and one touch on the person's phone fixes it.
  { check: BACKUP_PASSKEY_CHECK, startsOn: true },
]);

export const BACKUP_PASSKEY_REF = { kind: 'backup', id: 'passkey' } as const;

export const BACKUP_PASSKEY_WORDS = {
  title: 'Set up your passkey',
  body: 'One passkey to sign in, open all your Whombats and unlock your backups.',
  use: 'Set up my passkey',
} as const;

/** The item (pure). */
export function backupPasskeyItem(at: string): NeedsYouItem {
  return {
    id: `${BACKUP_PASSKEY_REF.kind}:${BACKUP_PASSKEY_REF.id}`,
    ref: { ...BACKUP_PASSKEY_REF },
    kind: 'backup',
    severity: 'info',
    nature: 'you',
    title: BACKUP_PASSKEY_WORDS.title,
    body: BACKUP_PASSKEY_WORDS.body,
    at,
    actions: [
      {
        id: 'passkey',
        label: BACKUP_PASSKEY_WORDS.use,
        style: 'primary',
        kind: 'open',
        href: BACKUP_PASSKEY_HREF,
      },
    ],
    href: BACKUP_PASSKEY_HREF,
  };
}

/** The source: for the person, while the box has backups and no passkey holds their key. */
export async function backupPasskeyNeedsYou(ctx: SourceCtx): Promise<NeedsYouItem[]> {
  const services = ctx.services;
  if (!services || !checkStartsOn(BACKUP_PASSKEY_CHECK)) return [];
  const status = await boxBackupStatus(services);
  if (!status?.lastSuccess) return [];
  const bringBack = await bringBackOf(services, status);
  if (
    !bringBack ||
    bringBack.state === 'none' ||
    bringBack.state === 'paper_only' ||
    bringBack.setup === 'saving' ||
    bringBack.setup === 'verified'
  )
    return [];
  if (!bringBack.setup && (bringBack.state !== 'needs_passkey' || bringBack.passkeys > 0)) return [];
  const person = ctx.reads?.person ?? (await loadPrincipalRow(ctx.db, ctx.personId));
  if (person?.kind !== 'person') return [];
  return [backupPasskeyItem(new Date(status.lastSuccess.at).toISOString())];
}

/**
 * Adds the ask to the backups' one Inbox item (idempotent; the managed runtime does at its start): it shows only while
 * no other backup item does.
 */
export function registerBackupPasskeySource(): void {
  addBackupAsk('backup-passkey', backupPasskeyNeedsYou);
}
