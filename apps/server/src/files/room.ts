/**
 * Whether the files' disk has room for more (docs/decisions/page-sets.md PG-20): without a fixed quota
 * (`WHOMBAT_BURROW_QUOTA_BYTES`), a file is kept while the disk keeps a reserve free for everything else on the box (its
 * database, backups, the agent's work) — 5 % of the disk, at least 5 GiB. One person's Whombat, so the disk is the limit.
 */
import { statfs } from 'node:fs/promises';
import type { Config } from '../config';
import { ApiError } from '../lib/errors';
import { filesDir } from './service';

export const DISK_RESERVE_FRACTION = 0.05;
export const DISK_RESERVE_MIN_BYTES = 5 * 1024 * 1024 * 1024;

/** What the disk keeps free: its reserve. */
export function diskReserve(totalBytes: number): number {
  return Math.max(DISK_RESERVE_MIN_BYTES, Math.floor(totalBytes * DISK_RESERVE_FRACTION));
}

/** Whether `size` more bytes leave the reserve free on a disk with `free` of `total` bytes free. */
export function diskFits(disk: { free: number; total: number }, size: number): boolean {
  return disk.free - size >= diskReserve(disk.total);
}

/** The files' disk as it is now; null when it can't be read (then nothing is refused for it). */
export async function filesDisk(config: Pick<Config, 'WHOMBAT_FILES_DIR' | 'WHOMBAT_HOME'>) {
  try {
    const s = await statfs(filesDir(config));
    return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return null;
  }
}

export const DISK_FULL =
  'This Whombat’s disk is nearly full, so it can’t keep that file. Remove some files or old backups to make room.';

/** The refusal when the disk has no room for a file. */
export function diskFull(): ApiError {
  return new ApiError('too_large', DISK_FULL, { details: { reason: 'disk' } });
}

/**
 * Whether `size` more bytes may be kept: within the fixed quota when one is set (`usedBytes` is what the burrow keeps
 * now, read only then), else within the disk's room.
 */
export async function filesRoom(
  config: Pick<Config, 'WHOMBAT_FILES_DIR' | 'WHOMBAT_HOME' | 'WHOMBAT_BURROW_QUOTA_BYTES'>,
  size: number,
  usedBytes: () => Promise<number>,
): Promise<'ok' | 'quota' | 'disk'> {
  const quota = config.WHOMBAT_BURROW_QUOTA_BYTES;
  if (quota !== undefined) return (await usedBytes()) + size > quota ? 'quota' : 'ok';
  const disk = await filesDisk(config);
  return !disk || diskFits(disk, size) ? 'ok' : 'disk';
}
