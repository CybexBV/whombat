/**
 * The words of Settings → Backups (contracts 0.79, CT-335; the sketch `mock-dark.png`: “Download a backup” and “Restore
 * from a file”) and of what Whombat says about backup files in conversations and the log (BF-08). Plain English, curly
 * quotes, the middle dot.
 */
import { coreTranslator } from '../i18n/catalog.js';
import { DOT } from '../text/format.js';
import {
  type BackupCategoryId,
  backupCategoryLabels,
  backupIncludesSecrets,
  formatBackupSize,
} from './categories.js';
import { BACKUP_PASSWORD_MIN } from './container.js';
import { joinAnd } from './notes.js';

/** Hours a made file is kept for download, and a staged upload for its restore (BF-10). */
export const BACKUP_FILE_TTL_HOURS = 24;

export const BACKUP_COPY = {
  /** The Settings tab and its breadcrumb. */
  tab: 'Backups',
  breadcrumb: `Settings ${DOT} Backups`,
  download: {
    title: 'Download a backup',
    intro: 'Choose what goes in the file. You can restore it here or on another Whombat.',
    passwordLabel: 'Password for this file',
    passwordHint: 'You need it to restore. Whombat can’t get it back for you.',
    passwordShort: `Use at least ${BACKUP_PASSWORD_MIN} characters.`,
    makeDefault: 'Make these the default',
    defaultSaved: 'These are the default now.',
    making: 'Making the file…',
    ready: 'Your file is ready.',
    kept: `It’s kept here for ${BACKUP_FILE_TTL_HOURS} hours.`,
    downloadAgain: 'Download again',
    remove: 'Remove',
    failed: 'The file couldn’t be made.',
  },
  restore: {
    title: 'Restore from a file',
    intro: 'Nothing here is deleted. You choose what to bring back.',
    choose: 'Choose a file',
    uploading: 'Uploading…',
    passwordLabel: 'Password for this file',
    open: 'Open',
    opening: 'Opening the file…',
    whenDifferent: 'When something is different',
    restore: 'Restore',
    cancel: 'Cancel',
    restoring: 'Restoring…',
    done: 'Restored',
  },
} as const;

/** `BACKUP_COPY` in a locale. */
export function backupCopy(locale?: string | null): {
  tab: string;
  breadcrumb: string;
  download: { [K in keyof (typeof BACKUP_COPY)['download']]: string };
  restore: { [K in keyof (typeof BACKUP_COPY)['restore']]: string };
} {
  const tr = coreTranslator(locale);
  const section = <S extends 'download' | 'restore'>(name: S) =>
    Object.fromEntries(
      Object.keys(BACKUP_COPY[name]).map((key) => [
        key,
        tr.t(`backup.copy.${name}.${key}` as 'backup.copy.download.title', {
          min: BACKUP_PASSWORD_MIN,
          hours: BACKUP_FILE_TTL_HOURS,
        }),
      ]),
    ) as { [K in keyof (typeof BACKUP_COPY)[S]]: string };
  return {
    tab: tr.t('backup.copy.tab'),
    breadcrumb: tr.t('backup.copy.breadcrumb'),
    download: section('download'),
    restore: section('restore'),
  };
}

/** “Download · 1.8 MB”: the button with the chosen categories' estimated size. */
export function backupDownloadLabel(bytes: number, locale?: string | null): string {
  return coreTranslator(locale).t('backup.downloadLabel', { size: formatBackupSize(bytes, locale) });
}

/** Progress of a job, 0–100, whole percent (`done` of `total`, never 100 before it is done). */
export function backupProgressPct(progress: { done: number; total: number }, finished = false): number {
  if (finished) return 100;
  if (progress.total <= 0) return 0;
  return Math.min(99, Math.floor((progress.done / progress.total) * 100));
}

/** “Making the file · 42 %”, or with the category: “Making the file · Messages · 42 %”. */
export function backupMakingText(
  progress: {
    done: number;
    total: number;
    step?: BackupCategoryId | null;
  },
  locale?: string | null,
): string {
  const step = progress.step ? ` ${DOT} ${backupCategoryLabels(locale)[progress.step]}` : '';
  return coreTranslator(locale).t('backup.making', { step, pct: backupProgressPct(progress) });
}

/** “Restoring · Automations · 42 %”. */
export function backupRestoringText(
  progress: {
    done: number;
    total: number;
    step?: BackupCategoryId | null;
  },
  locale?: string | null,
): string {
  const step = progress.step ? ` ${DOT} ${backupCategoryLabels(locale)[progress.step]}` : '';
  return coreTranslator(locale).t('backup.restoring', { step, pct: backupProgressPct(progress) });
}

/**
 * What the person reads in their assistant DM when a file holds sign-ins (BF-08, BF-13), one sentence: “You made a
 * backup file that includes connection sign-ins.”, “… connection sign-ins, your Vault and the keys to your servers.”
 * Keep it somewhere safe. Null when it holds none (nothing to say). Since 3.0 (CT-1512) for the person, not other owners.
 */
export function backupFileNoticeText(
  categories: readonly BackupCategoryId[],
  locale?: string | null,
): string | null {
  const tr = coreTranslator(locale);
  const parts: string[] = [];
  if (categories.includes('connections')) parts.push(tr.t('backup.notice.connections'));
  if (categories.includes('vault')) parts.push(tr.t('backup.notice.vault'));
  if (categories.includes('servers')) parts.push(tr.t('backup.notice.servers'));
  if (parts.length === 0) return null;
  const list =
    tr.language === 'en' || parts.length <= 1
      ? joinAnd(parts)
      : tr.t('backup.and', { items: parts.slice(0, -1).join(', '), last: parts[parts.length - 1] ?? '' });
  return tr.t('backup.notice', { parts: list });
}

/** The signed event of making a file (BF-08), for the log: “Made a backup file” (“… with sign-ins in it”). */
export function backupFileMadeText(categories: readonly BackupCategoryId[]): string {
  return backupIncludesSecrets(categories) ? 'Made a backup file with sign-ins in it' : 'Made a backup file';
}
