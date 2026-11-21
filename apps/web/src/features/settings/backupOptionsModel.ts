/**
 * The web's pieces of Settings → This Whombat → Backups beyond the shared words and views (`@whombat/client/managed`
 * backup-options; app backup-options.md AP-6800…): the options dialog's draft and what Save sends, the older backups'
 * range, and a backup's title. Pure.
 */
import { keepChoice } from '@whombat/client/managed';
import {
  BACKUP_KEEP_90_DAYS,
  BACKUP_KEEP_YEAR,
  BACKUP_LIMIT_MIN_BYTES,
  type BackupFrequency,
  type BackupKeep,
  type BackupLocalLeftover,
  type BackupPolicy,
  type BackupSetPolicyInput,
} from '@whombat/protocol/session';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** “3 Nov” (local). */
export function dayMonth(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

const pad = (n: number) => String(n).padStart(2, '0');
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** A backup's title: “Today, 03:00”, “Yesterday, 21:00”, “Sunday, 03:00” within a week, else “25 October, 03:00”. */
export function backupWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const day = sameDay(d, now)
    ? 'Today'
    : sameDay(d, y)
      ? 'Yesterday'
      : now.getTime() - d.getTime() < 6 * 86_400_000
        ? DAYS[d.getDay()]
        : `${d.getDate()} ${LONG_MONTHS[d.getMonth()]}`;
  return `${day}, ${time}`;
}

/** The older backups' dates: “20 Oct – 3 Nov”, one date when they're of one day. */
export function localRange(local: Pick<BackupLocalLeftover, 'oldest' | 'newest'>): string {
  const a = local.oldest ? dayMonth(local.oldest) : null;
  const b = local.newest ? dayMonth(local.newest) : null;
  if (a && b && a !== b) return `${a} – ${b}`;
  return a ?? b ?? '';
}

/* The options dialog ----------------------------------------------------------------------------------------- */

export interface PolicyDraft {
  frequency: BackupFrequency;
  keep: 'year' | 'days90' | 'custom';
  /** Choose…'s four fields as typed. */
  custom: Record<keyof BackupKeep, string>;
  limitOn: boolean;
  /** The limit in GB as typed. */
  limitGb: string;
  weeklyCheck: boolean;
}

export function draftOf(policy: BackupPolicy): PolicyDraft {
  const k = policy.keep;
  return {
    frequency: policy.frequency,
    keep: keepChoice(k),
    custom: {
      allDays: String(k.allDays),
      dailyDays: String(k.dailyDays),
      weeklyWeeks: String(k.weeklyWeeks),
      monthlyMonths: String(k.monthlyMonths),
    },
    limitOn: policy.limitBytes !== null,
    limitGb: policy.limitBytes !== null ? String(Math.round(policy.limitBytes / 1e9)) : '50',
    weeklyCheck: policy.weeklyCheck,
  };
}

const whole = (text: string, min: number, max: number) => {
  const n = Math.round(Number(text));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
};

/** What the draft keeps (Choose…'s fields within the contract's bounds; every backup for at least a day). */
export function draftKeep(d: PolicyDraft): BackupKeep {
  if (d.keep === 'year') return BACKUP_KEEP_YEAR;
  if (d.keep === 'days90') return BACKUP_KEEP_90_DAYS;
  return {
    allDays: whole(d.custom.allDays, 1, 3650),
    dailyDays: whole(d.custom.dailyDays, 0, 3650),
    weeklyWeeks: whole(d.custom.weeklyWeeks, 0, 520),
    monthlyMonths: whole(d.custom.monthlyMonths, 0, 240),
  };
}

/** The limit the draft sets, in bytes (at least 1 GB); null when it is off. */
export function draftLimit(d: PolicyDraft): number | null {
  if (!d.limitOn) return null;
  return Math.max(BACKUP_LIMIT_MIN_BYTES, whole(d.limitGb, 1, 1_000_000) * 1e9);
}

/** What Save sends (`backup.setPolicy`). */
export function draftInput(d: PolicyDraft): BackupSetPolicyInput {
  return {
    frequency: d.frequency,
    keep: draftKeep(d),
    limitBytes: draftLimit(d),
    weeklyCheck: d.weeklyCheck,
  };
}
