/**
 * Bringing a Whombat back on the web (app backup-options.md AP-6830…, backup-v2.md): the pure parts of the flow — where
 * it starts (a restore under way resumes), the old Whombat's name from a kit, and the rows of “Home’s backups”.
 */
import {
  ago,
  backupLabel,
  backupToBringBack,
  bringBackName,
  madeAfterReplaced,
} from '@whombat/client/managed';
import type { BackupCheckpoint, BackupRestoreState } from '@whombat/protocol/session';
import { backupWhen } from '../features/settings/backupOptionsModel';
import { currentLocale, webTranslator } from '../i18n/provider';

export type BringBackStep =
  | 'question'
  /** Bringing one back on a Whombat that started fresh: what's on it now is replaced, said first. */
  | 'replace'
  | 'kit'
  | 'paste'
  | 'choose'
  | 'working'
  | 'almost'
  | 'done'
  | 'failed';

/** Where the flow opens: a restore already under way on this box carries on where it is (a reload, another tab). */
export function stepOfRestore(state: Pick<BackupRestoreState, 'phase'> | null): BringBackStep | null {
  switch (state?.phase) {
    case 'restoring':
      return 'working';
    case 'checking':
      return 'almost';
    case 'failed':
      return 'failed';
    case 'released':
      return 'done';
    default:
      return null;
  }
}

/** The Whombat a kit file is for (its “Whombat:” line); null when it doesn't say, or names only its device id. */
export function kitWhombatName(text: string): string | null {
  const line = text.split(/\r?\n/).find((l) => l.trim().startsWith('Whombat: '));
  const name = line?.trim().slice('Whombat: '.length).trim();
  return name && bringBackName(name) === name ? name : null;
}

export interface ChooseRow {
  id: string;
  title: string;
  meta: string;
  /** The one picked first: the newest not made after its Whombat was replaced. */
  newest: boolean;
  /** Made by the old Whombat after another took its place (never picked first). */
  afterReplaced: boolean;
}

/**
 * “Today, 03:00” · “7 hours ago · checked: it restores”, newest first (the list's own order); a backup the old Whombat
 * made after it was replaced says so, and NEWEST marks the one picked first.
 */
export function chooseRows(checkpoints: readonly BackupCheckpoint[], now = new Date()): ChooseRow[] {
  const { t } = webTranslator(currentLocale());
  const late = madeAfterReplaced(checkpoints);
  const pick = backupToBringBack(checkpoints);
  return checkpoints.map((cp) => {
    const label = backupLabel(cp, false);
    const meta = [
      ago(cp.createdAt, currentLocale()),
      late.has(cp.id) ? t('backups.afterReplaced') : null,
      cp.reason === 'scheduled' ? null : label,
      cp.check?.ok ? t('backups.checkedLower') : null,
    ].filter(Boolean);
    return {
      id: cp.id,
      title: backupWhen(cp.createdAt, now),
      meta: meta.join(' · '),
      newest: cp.id === pick,
      afterReplaced: late.has(cp.id),
    };
  });
}

/** “03:00”, the time a restored backup was made (the person's own clock). */
export function restoredTime(state: Pick<BackupRestoreState, 'restored'> | null): string {
  const at = state?.restored?.createdAt;
  if (!at) return '';
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Where the flow opens when it was opened from the app (`later`): a restore under way resumes (`restoring`, `checking`,
 * `failed`); a finished one (`released`) or none is nothing to resume. Right after the claim a finished one is the done
 * screen, as a reload shows it.
 */
export function stepOfRestoreLater(state: Pick<BackupRestoreState, 'phase'> | null): BringBackStep | null {
  return state?.phase === 'released' ? null : stepOfRestore(state);
}
