/**
 * This Whombat's own backups for the rest of the server (Whombat first-day.md): the backup service's port and the
 * manager's last report of it, handed over by the managed runtime at its start, so Needs you can propose a place and
 * the assistant can set it. A box without a backup service (a development box) has none: nothing asks about backups
 * there.
 */
import { BackupServiceStatus } from '@whombat/control-contracts/local';
import type { Services } from '../services';
import { type BackupPort, READ } from './backup-port';

export interface BoxBackup {
  port: BackupPort;
  /** What the manager last reported (`POST /facts`); null before its first report. */
  status(): BackupServiceStatus | null;
}

const boxes = new WeakMap<Services, BoxBackup>();
/** The service's own answer when the manager hasn't reported yet, for a minute. */
const asked = new WeakMap<Services, { at: number; status: BackupServiceStatus | null }>();
/** An ask on its way: every read meanwhile shares its answer. */
const asking = new WeakMap<Services, Promise<BackupServiceStatus | null>>();
const ASKED_FOR_MS = 60_000;

export function useBoxBackup(services: Services, box: BoxBackup): void {
  boxes.set(services, box);
  asked.delete(services);
  asking.delete(services);
}

export function boxBackupOf(services: Services): BoxBackup | null {
  return boxes.get(services) ?? null;
}

/** The service's own status, or null when it didn't answer one (within the short read's deadline). */
async function askService(box: BoxBackup): Promise<BackupServiceStatus | null> {
  try {
    const res = await box.port.call('GET', '/v1/status', undefined, READ);
    const parsed = res.status === 200 ? BackupServiceStatus.safeParse(res.body) : null;
    return parsed?.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * One ask at a time: a read that comes while one is on its way gets the same answer. `fresh` (right after a change)
 * asks anew, since the one on its way may have started before the change; later reads share that one.
 */
function askShared(services: Services, box: BoxBackup, fresh: boolean): Promise<BackupServiceStatus | null> {
  const going = asking.get(services);
  if (going && !fresh) return going;
  const ask = askService(box).finally(() => {
    if (asking.get(services) === ask) asking.delete(services);
  });
  asking.set(services, ask);
  return ask;
}

/**
 * The backup service's status now: the newer of the manager's last report and the service's own answer (asked when
 * the manager hasn't reported yet, or `fresh` right after a change; kept a minute), else null (nothing answered:
 * unknown, never “not backed up”). `undefined` when this box has no backup service.
 */
export async function boxBackupStatus(
  services: Services,
  options: { fresh?: boolean } = {},
): Promise<BackupServiceStatus | null | undefined> {
  const box = boxBackupOf(services);
  if (!box) return undefined;
  const reported = box.status();
  const now = services.clock().getTime();
  let kept = asked.get(services);
  if (options.fresh || (!reported && (!kept || now - kept.at >= ASKED_FOR_MS))) {
    kept = { at: now, status: await askShared(services, box, options.fresh === true) };
    asked.set(services, kept);
  }
  const own = kept && now - kept.at < ASKED_FOR_MS ? kept.status : null;
  const status =
    !reported || !own
      ? (reported ?? own)
      : Date.parse(own.updatedAt) > Date.parse(reported.updatedAt)
        ? own
        : reported;
  if (status) noteFailing(services, status, now);
  return status;
}

/**
 * When the service was first seen saying `failing` since the last backup that worked (in memory: a restart starts
 * again, from the newest failure). Every status read keeps it, the keep-the-place-right job's every five minutes too.
 */
const failingSeen = new WeakMap<Services, { episode: string; at: number }>();

function noteFailing(services: Services, status: BackupServiceStatus, now: number): void {
  if (status.state !== 'failing') {
    failingSeen.delete(services);
    return;
  }
  const episode = status.lastSuccess?.at ?? 'never';
  if (failingSeen.get(services)?.episode === episode) return;
  const failed = Date.parse(status.lastFailure?.at ?? '');
  failingSeen.set(services, { episode, at: Number.isFinite(failed) ? Math.min(now, failed) : now });
}

/** Since when backups have been failing in this episode (ms), null when they aren't. */
export function backupFailingSince(services: Services): number | null {
  return failingSeen.get(services)?.at ?? null;
}
