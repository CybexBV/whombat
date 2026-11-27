import { coreTranslator, coreWords } from '../i18n/catalog.js';

/**
 * Getting one thing back from a backup (Whombat backup-look.md): the words the box, its assistant and the apps share —
 * what each category is called and the line that says how a bring-back went (“3 things are back. 1 was already here.”).
 * Pure.
 */

const BACKUP_LOOK_CATEGORY_NAMES_KEYS = [
  'messages',
  'files',
  'automations',
  'connections',
  'vault',
  'memories',
  'skills',
] as const;

/** What each category of an opened backup is called (the backup file's ids; `messages` are chats). */
export function backupLookCategoryNames(
  locale?: string | null,
): Readonly<Record<(typeof BACKUP_LOOK_CATEGORY_NAMES_KEYS)[number], string>> {
  return coreWords(locale, 'backupLook.category', BACKUP_LOOK_CATEGORY_NAMES_KEYS);
}

export const BACKUP_LOOK_CATEGORY_NAMES = backupLookCategoryNames('en');

export interface BackupLookTally {
  back: number;
  already: number;
  notBack: number;
  /** What came back, by title (the first is named when only one came back). */
  titles?: readonly string[];
  /** Connections that need the person to sign in again. */
  signIn?: readonly string[];
}

/**
 * How a bring-back went, in one to three short sentences: what is back (by name when it is one), what was here already,
 * what couldn't come back, and a connection that needs a sign-in.
 */
export function backupLookDoneLine(t: BackupLookTally, locale?: string | null): string {
  const tr = coreTranslator(locale);
  const parts: string[] = [];
  const only = t.back === 1 && t.titles?.[0] ? t.titles[0] : null;
  if (only) parts.push(tr.t('backupLook.done.one', { title: only }));
  else if (t.back > 0) parts.push(tr.tp('backupLook.done.back', t.back));
  if (t.already > 0)
    parts.push(
      t.back === 0 && t.notBack === 0
        ? tr.tp('backupLook.done.alreadyAll', t.already)
        : tr.tp('backupLook.done.already', t.already),
    );
  if (t.notBack > 0) parts.push(tr.tp('backupLook.done.notBack', t.notBack));
  if (parts.length === 0) parts.push(tr.t('backupLook.done.nothing'));
  const signIn = t.signIn?.filter(Boolean) ?? [];
  if (signIn.length === 1) parts.push(tr.t('backupLook.done.signInOne', { name: signIn[0] ?? '' }));
  else if (signIn.length > 1) parts.push(tr.tp('backupLook.done.signIn', signIn.length));
  return parts.join(' ');
}
