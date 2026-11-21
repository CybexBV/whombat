/**
 * Notes about a backup file and its restore (contracts 0.79, CT-335; moved out of `restore.ts` in 0.117, CT-905, so the
 * manifest can carry the notes of making a file): a code, the category it is about and a count, and their words.
 */
import { z } from 'zod';
import { Count } from '../domain/common.js';
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

const num = (v: number) => v.toLocaleString('en-US');

/** A note in one sentence: “2 automations no longer fit this Whombat, so they come back as drafts.” */
export function backupNoteText(note: BackupNoteInput): string {
  const n = note.count ?? 1;
  switch (note.code) {
    case 'unreadable':
      return n === 1
        ? '1 thing in the file couldn’t be read, so it’s left out.'
        : `${num(n)} things in the file couldn’t be read, so they’re left out.`;
    case 'missing_reference':
      return n === 1
        ? '1 thing points to something that isn’t here, so that part is left out.'
        : `${num(n)} things point to something that isn’t here, so that part is left out.`;
    case 'drafts':
      return n === 1
        ? '1 automation no longer fits this Whombat, so it comes back as a draft.'
        : `${num(n)} automations no longer fit this Whombat, so they come back as drafts.`;
    case 'schedules_paused':
      return n === 1 ? '1 schedule comes back paused.' : `${num(n)} schedules come back paused.`;
    case 'bundled_missing':
      return n === 1
        ? '1 skill comes with another version of Whombat, so it’s left out.'
        : `${num(n)} skills come with another version of Whombat, so they’re left out.`;
    case 'unknown_authors':
      return n === 1
        ? 'Messages from 1 person who isn’t here keep their name.'
        : `Messages from ${num(n)} people who aren’t here keep their names.`;
    case 'too_large':
      return n === 1
        ? '1 thing is too large to restore here, so it’s left out.'
        : `${num(n)} things are too large to restore here, so they’re left out.`;
    case 'model_unavailable':
      return 'The agent’s model isn’t offered here, so it uses this Whombat’s default.';
    case 'sign_in_left_out':
      return n === 1
        ? '1 sign-in couldn’t go in the file, so it needs you to sign in again.'
        : `${num(n)} sign-ins couldn’t go in the file, so they need you to sign in again.`;
    case 'files_left_out':
      return n === 1
        ? '1 message comes back without its files, because Files wasn’t in the backup.'
        : `${num(n)} messages come back without their files, because Files wasn’t in the backup.`;
  }
}

/** “a, b and c”. */
export function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
