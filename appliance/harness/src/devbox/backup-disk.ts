/**
 * `dev/devbox backup-disk` (IN-423; Whombat HE-53): the DEV box gets a backup destination, so the manager can take the
 * verified pre-migration checkpoint a `contract` migration needs (Whombat MD-06, BK-17) instead of waiting for one.
 *
 * The destination is the backup disk (BK-20, BK-27): a custom block volume in the VM's pool, attached to the running
 * VM as its device `backup`, then chosen inside the box as the person's Settings → This Whombat → “A disk on this
 * Whombat” chooses it — the same `PUT /v1/destination {repository: "disk:", allowInit: true}` on the backup service's
 * socket, sent as the runtime's user (the only one that route answers, BK-25), so the root helper formats the one
 * empty disk (ext4, WHOMBAT-BACKUP), pins and mounts it. Then a first backup (`POST /v1/checkpoints {reason:
 * "manual"}`, the app's “Back up now”), and the status must say `protected`.
 *
 * Idempotent: the volume is kept when it is this box's (attached, or made for its serial), a previous box's is
 * renamed aside (its repository opens only with the old kit's password; nothing is deleted), the device is added once,
 * a disk destination already set is kept, another kind of destination is never replaced, and no backup is taken when
 * the status is already `protected`. Runs through the Incus agent as root (NX-143); nothing else on the box changes.
 */
import { sleep } from '../lib/proc.ts';
import {
  agentReady,
  attachBackupVolume,
  BACKUP_DISK_IN_BOX,
  BACKUP_VOLUME,
  backupDeviceSource,
  boxExec,
  createBackupVolume,
  customVolumes,
  renameVolume,
  VM,
  type VolumeInfo,
} from './incus.ts';

export const DEFAULT_BACKUP_DISK_SIZE = '64GiB';
const API_SOCKET = '/run/whombat-backup/api.sock';
/** The runtime's user: the backup API answers `PUT /v1/destination` only to it (BK-25). */
const RUNTIME_USER = 'whombat';

export type VolumePlan =
  | { act: 'create' }
  | { act: 'keep' }
  | { act: 'set-aside'; to: string }
  | { act: 'refuse'; reason: string };

/** The box serial a backup volume was made for, from its description. */
export function volumeSerial(description: string): string | null {
  return /\b(WBDEVBOX-[0-9A-F]+)\b/.exec(description)?.[1] ?? null;
}

const usedByVm = (usedBy: string[]) =>
  usedBy.some((u) => new RegExp(`^/1\\.0/instances/${VM}(\\?|$)`).test(u));

/**
 * What to do with the pool's backup volume for the box with this serial: keep it when it is attached to the VM or was
 * made for this box, rename a previous box's aside (by its serial, else the day it was made), refuse one another
 * instance uses.
 */
export function planBackupVolume(v: VolumeInfo | null, serial: string, names: string[]): VolumePlan {
  if (!v) return { act: 'create' };
  if (usedByVm(v.usedBy)) return { act: 'keep' };
  if (v.usedBy.length)
    return { act: 'refuse', reason: `${v.name} is attached to ${v.usedBy.join(', ')}, not ${VM}` };
  const was = volumeSerial(v.description);
  if (was === serial) return { act: 'keep' };
  const stem = `${v.name}-${was ?? (v.createdAt.slice(0, 10).replace(/-/g, '') || 'old')}`;
  let to = stem;
  for (let i = 2; names.includes(to); i++) to = `${stem}-${i}`;
  return { act: 'set-aside', to };
}

/** `--size`: a whole number of MiB, GiB or TiB, at least the 1 GiB the disk helper needs (BK-20). */
export function validateSize(size: string): string {
  const m = /^([1-9]\d*)(MiB|GiB|TiB)$/.exec(size);
  const mib = m ? Number(m[1]) * { MiB: 1, GiB: 1024, TiB: 1024 * 1024 }[m[2] as 'MiB' | 'GiB' | 'TiB'] : 0;
  if (mib < 1024) throw new Error(`--size ${size}: a size such as 64GiB, at least 1GiB`);
  return size;
}

/** curl's arguments for one call of the backup service's local API as the runtime's user. */
export function apiCall(
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body?: unknown,
  maxTimeS = 60,
): string[] {
  return [
    'runuser',
    '-u',
    RUNTIME_USER,
    '--',
    'curl',
    '-sS',
    '-m',
    String(maxTimeS),
    '--unix-socket',
    API_SOCKET,
    '-X',
    method,
    ...(body === undefined
      ? []
      : ['-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(body)]),
    '-w',
    '\n%{http_code}',
    `http://backup${path}`,
  ];
}

/** curl's output with `-w '\n%{http_code}'`: the answer's status and JSON body. */
export function parseApiAnswer(stdout: string): { status: number; body: unknown } {
  const i = stdout.lastIndexOf('\n');
  const status = Number(stdout.slice(i + 1).trim());
  const text = stdout.slice(0, Math.max(i, 0)).trim();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: keep the text
  }
  return { status: Number.isFinite(status) ? status : 0, body };
}

/** The backup service's error message (contracts LocalError), else the body as it came. */
export function apiError(body: unknown): string {
  const e = (body as { error?: { code?: string; message?: string; stage?: string } } | null)?.error;
  if (e?.message) return `${e.code ?? 'error'}${e.stage ? ` at ${e.stage}` : ''}: ${e.message}`;
  return typeof body === 'string' ? body : JSON.stringify(body);
}

/** The fields of the backup status (contracts `local.BackupServiceStatus`) this command reads. */
export interface BackupStatus {
  state: string;
  protected: boolean;
  destination: { configured: boolean; kind?: string; display?: string; repositoryId?: string };
  lastSuccess: {
    id: string;
    at: string;
    snapshotId?: string;
    method?: string;
    durationMs?: number;
    bytesAdded?: number;
    totalBytes?: number;
    files?: number;
  } | null;
  lastFailure: { reason: string; at?: string; stage?: string } | null;
  kitGeneration?: number;
  running?: unknown;
}

async function api(
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body?: unknown,
  maxTimeS = 60,
): Promise<{ status: number; body: unknown }> {
  const r = await boxExec(apiCall(method, path, body, maxTimeS), (maxTimeS + 60) * 1000);
  if (r.code !== 0 && !r.stdout.trim())
    throw new Error(`${method} ${path} on the box's backup service: ${r.stderr.trim() || `exit ${r.code}`}`);
  return parseApiAnswer(r.stdout);
}

async function backupStatus(): Promise<BackupStatus> {
  const r = await api('GET', '/v1/status');
  if (r.status !== 200) throw new Error(`the box's backup status: ${r.status} ${apiError(r.body)}`);
  return r.body as BackupStatus;
}

/** One line for the status. */
export function statusLine(s: BackupStatus): string {
  const d = s.destination.configured
    ? `${s.destination.kind ?? '?'} ${s.destination.display ?? ''}`.trim()
    : 'no destination';
  const ok = s.lastSuccess
    ? ` · last backup ${s.lastSuccess.at} (snapshot ${s.lastSuccess.snapshotId ?? '?'})`
    : ' · no backup yet';
  const failed = s.lastFailure && s.state !== 'protected' ? ` · ${s.lastFailure.reason}` : '';
  return `${s.state} · ${d}${ok}${failed}`;
}

export interface BackupDiskResult {
  volume: string;
  setAside: string | null;
  attached: 'now' | 'already';
  before: BackupStatus;
  destination: Record<string, unknown> | 'already';
  checkpoint: Record<string, unknown> | null;
  after: BackupStatus;
  protected: boolean;
}

/** The disk, the destination, a first backup; `protected` at the end, or the status's reason why not. */
export async function backupDisk(
  serial: string,
  size: string,
  say: (s: string) => void,
): Promise<BackupDiskResult> {
  validateSize(size);
  await agentReady();

  // The volume: this box's, a fresh one, or a previous box's set aside first.
  const vols = await customVolumes();
  const plan = planBackupVolume(
    vols.find((v) => v.name === BACKUP_VOLUME) ?? null,
    serial,
    vols.map((v) => v.name),
  );
  let setAside: string | null = null;
  if (plan.act === 'refuse') throw new Error(plan.reason);
  if (plan.act === 'set-aside') {
    await renameVolume(BACKUP_VOLUME, plan.to);
    setAside = plan.to;
    say(
      `${BACKUP_VOLUME} was a previous box's: renamed ${plan.to} (kept; delete it when its backups aren't needed)`,
    );
  }
  if (plan.act !== 'keep') {
    await createBackupVolume(serial, size);
    say(`${BACKUP_VOLUME} created (block, ${size})`);
  } else say(`${BACKUP_VOLUME} is this box's`);

  // The device.
  const source = await backupDeviceSource();
  let attached: 'now' | 'already' = 'already';
  if (source === null) {
    await attachBackupVolume();
    attached = 'now';
    say(`${BACKUP_VOLUME} attached to ${VM} as the device backup`);
  } else if (source !== BACKUP_VOLUME)
    throw new Error(`${VM}'s device backup is ${source}, not ${BACKUP_VOLUME}: leaving it as it is`);
  for (let until = Date.now() + 90_000; ; ) {
    if ((await boxExec(['test', '-b', BACKUP_DISK_IN_BOX], 30_000)).code === 0) break;
    if (Date.now() > until)
      throw new Error(`the box doesn't see the disk (${BACKUP_DISK_IN_BOX}) after 90 s`);
    await sleep(2000);
  }

  // The destination, as the person's “A disk on this Whombat” with “prepare the disk”.
  const before = await backupStatus();
  say(`backup status before: ${statusLine(before)}`);
  let destination: BackupDiskResult['destination'] = 'already';
  if (before.destination.configured) {
    if (before.destination.kind !== 'disk')
      throw new Error(
        `the box already backs up to ${before.destination.kind} (${before.destination.display ?? ''}): ` +
          'dev/devbox backup-disk never replaces a destination',
      );
    say('the destination is the backup disk already');
  } else {
    say('setting the destination: disk:, prepare the disk (formats the one empty disk, up to ~2 minutes)');
    const r = await api('PUT', '/v1/destination', { repository: 'disk:', allowInit: true }, 600);
    if (r.status !== 200)
      throw new Error(`the backup service didn't take the disk: ${r.status} ${apiError(r.body)}`);
    destination = r.body as Record<string, unknown>;
    say(
      `destination set: ${String(destination.kind)}, repository ${String(destination.repositoryId)}, kit generation ${String(destination.generation)}`,
    );
  }

  // A first backup, as “Back up now”.
  let checkpoint: Record<string, unknown> | null = null;
  const now = await backupStatus();
  if (now.state !== 'protected') {
    say('first backup (POST /v1/checkpoints, reason manual)');
    const r = await api('POST', '/v1/checkpoints', { reason: 'manual' }, 3600);
    if (r.status === 409) {
      say('a backup is already running: waiting for it');
      for (let until = Date.now() + 3_600_000; (await backupStatus()).running; ) {
        if (Date.now() > until) throw new Error('the running backup didn’t finish within an hour');
        await sleep(10_000);
      }
    } else if (r.status !== 200) throw new Error(`the first backup failed: ${r.status} ${apiError(r.body)}`);
    else checkpoint = r.body as Record<string, unknown>;
  }
  const after = await backupStatus();
  say(`backup status after: ${statusLine(after)}`);
  return {
    volume: BACKUP_VOLUME,
    setAside,
    attached,
    before,
    destination,
    checkpoint,
    after,
    protected: after.state === 'protected',
  };
}
