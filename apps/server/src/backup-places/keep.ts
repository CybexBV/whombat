/**
 * What a backup place's cleanup keeps (docs/decisions/backup-options.md BKO-03…BKO-05): the person's policy as the
 * cleanup on the NAS runs it — every backup of `allDays`, one a day, a week and a month for their windows, and the
 * space limit. Read from the backup service's policy each time a cleanup is handed over.
 */
import {
  BACKUP_POLICY_DEFAULT,
  BackupKeep,
  BackupPolicy,
  type BackupPolicy as Policy,
} from '@whombat/protocol/session';
import { z } from 'zod';
import { type BackupPort, READ } from '../managed/backup-port';

export interface PlaceKeep {
  allDays: number;
  dailyDays: number;
  weeklyWeeks: number;
  monthlyMonths: number;
  limitBytes: number | null;
}

/** What every place kept before there were options: every backup of 90 days. */
export const PLACE_KEEP_90: PlaceKeep = {
  allDays: 90,
  dailyDays: 0,
  weeklyWeeks: 0,
  monthlyMonths: 0,
  limitBytes: null,
};

/** The policy as a place keeps it. A cleanup keeps every backup a week at least unless it keeps one a day for a week. */
export function placeKeepOf(policy: Pick<Policy, 'keep' | 'limitBytes'>): PlaceKeep {
  const k = policy.keep;
  return {
    allDays: k.dailyDays >= 7 ? k.allDays : Math.max(k.allDays, 7),
    dailyDays: k.dailyDays,
    weeklyWeeks: k.weeklyWeeks,
    monthlyMonths: k.monthlyMonths,
    limitBytes: policy.limitBytes,
  };
}

/** Whether a keep has more than the plain days (what a cleanup from before had). */
export function keepHasWindows(k: PlaceKeep): boolean {
  return k.dailyDays > 0 || k.weeklyWeeks > 0 || k.monthlyMonths > 0 || (k.limitBytes ?? 0) > 0;
}

/**
 * The longest window of a keep in days: what a helper that only knows `keep_within_days` gets, so it never clears a
 * backup the person's windows keep (it keeps more instead, until it is updated).
 */
export function longestKeepDays(k: PlaceKeep): number {
  const days = Math.max(k.allDays, k.dailyDays, k.weeklyWeeks * 7, Math.ceil((k.monthlyMonths * 365) / 12));
  return Math.min(days, KEEP_DAYS_MAX);
}

/** The most days a helper's cleanup keeps every backup for (hosts `PlaceKeepDaysMax`). */
export const KEEP_DAYS_MAX = 3650;

/** Whether two keeps clear the same backups. */
export function sameKeep(a: PlaceKeep, b: PlaceKeep): boolean {
  return (
    a.allDays === b.allDays &&
    a.dailyDays === b.dailyDays &&
    a.weeklyWeeks === b.weeklyWeeks &&
    a.monthlyMonths === b.monthlyMonths &&
    (a.limitBytes ?? null) === (b.limitBytes ?? null)
  );
}

/** The windows and limit of a policy, read on their own (a newer service's other members don't matter to them). */
const KeepPart = z.object({
  keep: z.object(BackupKeep.shape),
  limitBytes: BackupPolicy.shape.limitBytes,
});

/**
 * The person's policy as the backup service has it now: `policy` when it parses as a whole (only then may it be
 * written back with one thing changed), `keep` whenever its windows and limit parse. `older`: a service from before
 * the options (it keeps the recommended ones). Both null when it didn't answer or its answer isn't understood: then
 * nothing is changed from it, and never to the defaults.
 */
export interface PolicyRead {
  older: boolean;
  policy: Policy | null;
  keep: PlaceKeep | null;
}

export async function readPolicy(port: BackupPort): Promise<PolicyRead> {
  const none: PolicyRead = { older: false, policy: null, keep: null };
  const res = await port.call('GET', '/v1/policy', undefined, READ).catch(() => null);
  if (!res) return none;
  if (res.status === 404 || res.status === 405)
    return { older: true, policy: null, keep: placeKeepOf(BACKUP_POLICY_DEFAULT) };
  if (res.status !== 200) return none;
  const whole = BackupPolicy.safeParse(res.body);
  const part = KeepPart.safeParse(res.body);
  return {
    older: false,
    policy: whole.success ? whole.data : null,
    keep: part.success ? placeKeepOf(part.data) : null,
  };
}

/**
 * What a place's cleanup is handed when it is set up: the person's windows, or the recommended ones while the service
 * doesn't say (a service from before the options, or no answer now; the keep-the-place-right job hands the person's
 * once it can read them).
 */
export async function currentPlaceKeep(port: BackupPort | undefined): Promise<PlaceKeep> {
  if (!port) return placeKeepOf(BACKUP_POLICY_DEFAULT);
  return (await readPolicy(port)).keep ?? placeKeepOf(BACKUP_POLICY_DEFAULT);
}
