import type { HostBackupJob, HostGuest } from '@whombat/core';

export const DAY_MS = 86_400_000;

const PERIODS: Readonly<Record<string, number>> = {
  hourly: DAY_MS / 24,
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
  monthly: 31 * DAY_MS,
  quarterly: 92 * DAY_MS,
  'semi-annually': 184 * DAY_MS,
  yearly: 366 * DAY_MS,
  annually: 366 * DAY_MS,
};

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function daysInWeek(text: string): number[] | null {
  const days = new Set<number>();
  for (const item of text.split(',')) {
    const [start, end = start, extra] = item.split('..');
    const first = DAYS.indexOf(start ?? '');
    const last = DAYS.indexOf(end ?? '');
    if (first < 0 || last < 0 || extra !== undefined) return null;
    const count = ((last + 7 - first) % 7) + 1;
    for (let i = 0; i < count; i++) days.add((first + i) % 7);
  }
  return [...days].sort((a, b) => a - b);
}

/** The longest normal gap in simple Proxmox schedules. Other schedules use the unknown-rhythm threshold. */
export function backupPeriod(schedule: string): number | null {
  const value = schedule.trim().toLowerCase();
  if (Object.hasOwn(PERIODS, value)) return PERIODS[value] ?? null;
  const minutes = Number(/^\*\/(\d+)$/.exec(value)?.[1]);
  if (minutes >= 1 && minutes <= 59) return minutes * 60_000;
  const timed = /^(?:([a-z,.]+)\s+)?\d{1,2}:\d{2}$/.exec(value);
  if (!timed) return null;
  if (!timed[1]) return DAY_MS;
  const days = daysInWeek(timed[1]);
  if (!days?.length) return null;
  return Math.max(...days.map((day, i) => (days[i + 1] ?? (days[0] as number) + 7) - day)) * DAY_MS;
}

/** Of the schedules we can match to the guest, use the shortest known interval. Pool membership isn't in a guest row. */
export function backupRhythm(
  jobs: readonly HostBackupJob[],
  guest: Pick<HostGuest, 'id' | 'node'>,
): number | null {
  const periods = jobs
    .filter(
      (job) =>
        job.enabled &&
        (!job.node || job.node === guest.node) &&
        (job.selection === 'guests'
          ? job.guests?.includes(guest.id)
          : job.selection === 'all' && !job.exclude?.includes(guest.id)),
    )
    .flatMap((job) => {
      const period = backupPeriod(job.schedule);
      return period === null ? [] : [period];
    });
  return periods.length ? Math.min(...periods) : null;
}
