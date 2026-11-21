/**
 * Where backup files live while they are kept (docs/decisions/backup-file.md BF-10, BF-D03): one staging directory under
 * WHOMBAT_HOME, `backup-files/`, mode 0700, with a `CACHEDIR.TAG` so the appliance's restic box backups skip it (and
 * `whombat backup` leaves it out by name). Made files, uploads and a job's scratch go there, each 0600, under names
 * the server chooses (never a name a request sent). Free space is checked before anything is made or accepted.
 */
import { mkdir, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostPaths } from '@whombat/agent-runtime/host';
import type { Config } from '../config';

/** The directory's name in WHOMBAT_HOME (the CLI's whole-home backup leaves it out too). */
export const BACKUP_STAGING_DIR = 'backup-files';

/** The Cache Directory Tagging Specification's signature (https://bford.info/cachedir/). */
export const CACHEDIR_TAG =
  'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by Whombat.\n# Backup files waiting to be downloaded or restored: kept 24 hours, never backed up.\n';

/** Room kept free beyond what a job needs (the database and everything else go on writing). */
export const BACKUP_DISK_RESERVE_BYTES = 512 * 1024 * 1024;

export type StagingConfig = Pick<Config, 'WHOMBAT_HOME' | 'WHOMBAT_BACKUP_FILES_DIR'>;

/** `$WHOMBAT_HOME/backup-files` (or `WHOMBAT_BACKUP_FILES_DIR`, tests). */
export function stagingDir(config: StagingConfig): string {
  if (config.WHOMBAT_BACKUP_FILES_DIR) return config.WHOMBAT_BACKUP_FILES_DIR;
  return join(hostPaths({ WHOMBAT_HOME: config.WHOMBAT_HOME }).whombatHome, BACKUP_STAGING_DIR);
}

/** Makes the staging directory (0700) with its `CACHEDIR.TAG`; returns it. */
export async function ensureStaging(config: StagingConfig): Promise<string> {
  const dir = stagingDir(config);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tag = join(dir, 'CACHEDIR.TAG');
  const has = await stat(tag).then(
    () => true,
    () => false,
  );
  if (!has) await writeFile(tag, CACHEDIR_TAG, { mode: 0o600 });
  return dir;
}

/** A made file's name in the staging directory. */
export const madeFileName = (id: string) => `${id}.wbk`;
/** An upload's name in the staging directory. */
export const uploadFileName = (id: string) => `${id}.upload`;
/** A job's scratch directory (spooled records, bundles), removed when the job ends. */
export const scratchName = (id: string) => `${id}.work`;

/** A name inside the staging directory (only names the server made: no separators). */
export function stagedPath(config: StagingConfig, name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('.'))
    throw new Error(`backup staging: bad name ${name}`);
  return join(stagingDir(config), name);
}

/** Bytes free for this process on the staging directory's filesystem (null when it can't tell). */
export async function freeBytes(config: StagingConfig): Promise<number | null> {
  try {
    const s = await statfs(await ensureStaging(config));
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Whether `bytes` more fit, keeping the reserve (unknown free space counts as room). */
export async function hasRoom(config: StagingConfig, bytes: number): Promise<boolean> {
  const free = await freeBytes(config);
  return free === null || free >= bytes + BACKUP_DISK_RESERVE_BYTES;
}

/** Removes a staged file or scratch directory (missing is fine). */
export async function removeStaged(config: StagingConfig, name: string | null | undefined): Promise<void> {
  if (!name) return;
  await rm(stagedPath(config, name), { recursive: true, force: true });
}

/** Names in the staging directory (none when it doesn't exist yet). */
export async function stagedNames(config: StagingConfig): Promise<string[]> {
  try {
    return (await readdir(stagingDir(config))).filter((n) => n !== 'CACHEDIR.TAG');
  } catch {
    return [];
  }
}
