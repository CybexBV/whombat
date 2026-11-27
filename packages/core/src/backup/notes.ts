/**
 * Notes about a backup file and its restore (contracts 0.79, CT-335; moved out of `restore.ts` in 0.117, CT-905, so the
 * manifest can carry the notes of making a file): a code, the category it is about and a count, and their words.
 */
import { z } from 'zod';
import { Count } from '../domain/common.js';
import { isEnglishLocale, tCore, tpCore } from '../i18n/catalog.js';
import { formatLocaleNumber } from '../i18n/format.js';
import { BackupCategoryId } from './categories.js';

/**
 * Something a person should know about a restore, by code (the words come from `backupNoteText`):
 * - `unreadable`: records that didn't parse (left out);
 * - `missing_reference`: things that point to something neither here nor in the file (that part is left out);
 * - `drafts`: automations whose definition no longer validates here (they come back as drafts);
 * - `schedules_paused`: agents' schedules come back paused (BF-07);
 * - `bundled_missing`: skills shipped with another Whombat version that this one doesn't ship (left out): an own copy's
 *   original;
 * - `unknown_authors`: messages by someone who isn't here keep their author's name (a file from another Whombat);
 * - `too_large`: repositories or files too large to restore here (left out);
 *
 * since 0.117 (CT-905; Whombat backup-file.md BF-19):
 * - `model_unavailable`: the agent's model isn't offered by this Whombat (it gets its default);
 * - `sign_in_left_out`: sign-ins that couldn't be read when the file was made (connector accounts and apps, feedback
 *   sources, connections): they come back needing a sign-in (a note in the manifest, `BackupFileManifest.notes`);
 * - `files_left_out`: messages whose files aren't in the file because Files wasn't in it (a manifest note too).
 */
export const BACKUP_NOTE_CODES = [
  'unreadable',
  'missing_reference',
  'drafts',
  'schedules_paused',
  'bundled_missing',
  'unknown_authors',
  'too_large',
  'model_unavailable',
  'sign_in_left_out',
  'files_left_out',
] as const;
export const BackupNoteCode = z.enum(BACKUP_NOTE_CODES);
export type BackupNoteCode = z.infer<typeof BackupNoteCode>;

export const BackupNote = z.object({
  code: BackupNoteCode,
  /** The category it is about (null: the whole restore). */
  category: BackupCategoryId.nullable().default(null),
  count: Count.default(1),
});
export type BackupNote = z.infer<typeof BackupNote>;
export type BackupNoteInput = z.input<typeof BackupNote>;

/** A count as the note says it: English keeps its thousands commas, other languages their own separators. */
function num(v: number, locale: string | null | undefined): string {
  return isEnglishLocale(locale) ? v.toLocaleString('en-US') : formatLocaleNumber(v, locale);
}

/** A note in one sentence: “2 automations no longer fit this Whombat, so they come back as drafts.” */
export function backupNoteText(note: BackupNoteInput, locale?: string | null): string {
  // A formatter passed straight to `Array.map` receives an index here; anything but a tag means English.
  const tag = typeof locale === 'string' ? locale : null;
  const n = note.count ?? 1;
  if (note.code === 'model_unavailable') return tCore(tag, 'backupNote.model_unavailable');
  return tpCore(tag, `backupNote.${note.code}`, n, { count: num(n, tag) });
}

/** “a, b and c”, in a locale. */
export function joinAnd(parts: readonly string[], locale?: string | null): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return tCore(typeof locale === 'string' ? locale : null, 'recipe.and', {
    items: parts.slice(0, -1).join(', '),
    last: parts[parts.length - 1] ?? '',
  });
}
