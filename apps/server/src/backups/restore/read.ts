/**
 * Reading an uploaded backup file to its end (BF-06, CT-335: damage is caught before anything is restored): the
 * manifest, the directory, the chosen categories' records into encrypted spools (counted), and — for a restore — the
 * bytes those records point to into the job's scratch, each checked against its sha256.
 */
import { createHash } from 'node:crypto';
import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type BackupCategoryId,
  type BackupDirectoryEntry,
  BackupFileError,
  type BackupFileManifest,
  decodeBackupFileManifest,
  encodeBackupLine,
  parseBackupDirectoryEntry,
} from '@whombat/core';
import { readBackupBody } from '../body';
import { Spool } from '../spool';

export interface ReadUpload {
  manifest: BackupFileManifest;
  directory: Map<string, BackupDirectoryEntry>;
  /** Directory lines that didn't parse. */
  unreadableDirectory: number;
  spools: Map<BackupCategoryId, { spool: Spool; lines: number }>;
  /** Every blob the file holds (sha256). */
  blobs: Set<string>;
  /**
   * The hosts service's backup in the file (`servers/hub.tar.gz`, BF-13): its size, and for a restore that brings the
   * servers back its bytes in an encrypted spool (it holds the authority's key, BF-D04). Null when the file has none.
   */
  hostsBackup: { size: number; spool: Spool | null } | null;
}

export interface ReadOptions {
  /** Where spools (and kept bytes) go. */
  scratch: string;
  /** The categories whose records are kept. */
  keep: ReadonlySet<BackupCategoryId>;
  /** Keep the bytes the kept records point to (a restore; a preview only notes which blobs are there). */
  keepBytes: boolean;
  onBytes?: (n: number) => void;
}

/** Which blobs, canvases and bundles kept records point to. */
export function wantedBytes(category: BackupCategoryId, value: unknown, wanted: Set<string>): void {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') return;
  if (category === 'messages' && v.type === 'message' && Array.isArray(v.attachments))
    for (const a of v.attachments as { sha256?: unknown }[])
      if (typeof a?.sha256 === 'string') wanted.add(`blob:${a.sha256}`);
  if (category === 'messages' && v.type === 'canvas' && typeof v.id === 'string')
    wanted.add(`canvas:${v.id}`);
  if (category === 'files' && v.type === 'file' && typeof v.sha256 === 'string')
    wanted.add(`blob:${v.sha256}`);
  // A Hermes home's or the shared skills' archive (HE-S123).
  if (
    (category === 'memories' && v.type === 'hermes_home') ||
    (category === 'skills' && v.type === 'hermes_skills')
  ) {
    const archive = v.archive as { sha256?: unknown } | null | undefined;
    if (typeof archive?.sha256 === 'string') wanted.add(`blob:${archive.sha256}`);
  }
  if (category === 'repositories' && v.type === 'repository' && typeof v.name === 'string')
    wanted.add(`repo:${v.name}`);
  // The maker's photo (BF-20, BF-S18).
  const photo = v.photo as { sha256?: unknown } | null | undefined;
  if (category === 'settings' && v.type === 'account_profile' && typeof photo?.sha256 === 'string')
    wanted.add(`blob:${photo.sha256}`);
}

export async function readUpload(path: string, password: string, o: ReadOptions): Promise<ReadUpload> {
  let manifest: BackupFileManifest | null = null;
  const directory = new Map<string, BackupDirectoryEntry>();
  let unreadableDirectory = 0;
  const spools = new Map<BackupCategoryId, { spool: Spool; lines: number }>();
  const blobs = new Set<string>();
  const wanted = new Set<string>();
  let hostsBackup: ReadUpload['hostsBackup'] = null;
  try {
    await readBackupBody(
      path,
      password,
      {
        manifest(bytes) {
          manifest = decodeBackupFileManifest(bytes);
        },
        async record(kind, value) {
          if (kind.kind === 'directory') {
            const parsed = parseBackupDirectoryEntry(value);
            if (parsed.ok) directory.set(parsed.entry.id, parsed.entry);
            else unreadableDirectory++;
            return;
          }
          if (!o.keep.has(kind.category)) return;
          let s = spools.get(kind.category);
          if (!s) {
            s = { spool: await Spool.create(join(o.scratch, `${kind.category}.jsonl`)), lines: 0 };
            spools.set(kind.category, s);
          }
          await s.spool.write(encodeBackupLine(value));
          s.lines++;
          if (o.keepBytes) wantedBytes(kind.category, value, wanted);
        },
        async bytes(kind, size) {
          if (kind.kind === 'hosts_backup') {
            if (!o.keepBytes || !o.keep.has('servers')) {
              hostsBackup = { size, spool: null };
              return null;
            }
            const spool = await Spool.create(join(o.scratch, 'hub.tar.gz'));
            hostsBackup = { size, spool };
            let n = 0;
            return {
              async write(data: Uint8Array) {
                n += data.length;
                await spool.write(data);
              },
              async end() {
                await spool.close();
                if (n !== size) throw new BackupFileError('damaged', 'bytes of the hosts backup');
              },
            };
          }
          let name: string | null = null;
          if (kind.kind === 'blob') {
            blobs.add(kind.sha256);
            if (o.keepBytes && wanted.has(`blob:${kind.sha256}`)) name = `blob-${kind.sha256}`;
          } else if (kind.kind === 'canvas') {
            if (o.keepBytes && wanted.has(`canvas:${kind.canvasId}`)) name = `canvas-${kind.canvasId}`;
          } else if (kind.kind === 'repository') {
            if (o.keepBytes && wanted.has(`repo:${kind.name}`)) name = `bundle-${kind.name}`;
          }
          // `hosts_backup`: stream V keeps the servers' backup (BF-14).
          if (!name) return null;
          const fh: FileHandle = await open(join(o.scratch, name), 'w', 0o600);
          const hash = createHash('sha256');
          let n = 0;
          const expected = kind.kind === 'blob' ? kind.sha256 : null;
          return {
            async write(data: Uint8Array) {
              hash.update(data);
              n += data.length;
              await fh.write(data);
            },
            async end() {
              await fh.close();
              if (n !== size || (expected && hash.digest('hex') !== expected))
                throw new BackupFileError('damaged', `bytes of ${name}`);
            },
          };
        },
      },
      { ...(o.onBytes ? { onBytes: o.onBytes } : {}) },
    );
  } catch (err) {
    for (const s of spools.values()) await s.spool.remove().catch(() => {});
    await (hostsBackup as ReadUpload['hostsBackup'])?.spool?.remove().catch(() => {});
    throw err;
  }
  for (const s of spools.values()) await s.spool.close();
  if (!manifest) throw new BackupFileError('damaged', 'no manifest');
  return { manifest, directory, unreadableDirectory, spools, blobs, hostsBackup };
}
