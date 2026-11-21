/**
 * Making a backup file (docs/decisions/backup-file.md BF-05, BF-06, BF-10, BF-D05): the chosen categories are read in
 * one read-only snapshot by their collectors into encrypted spools (counts and bytes known), then the body is written —
 * manifest, directory, the categories' records, then the bytes they point to — through the tar writer and the encoder
 * into `<id>.wbk` in the staging directory. Nothing unencrypted touches the disk; nothing large is held in memory.
 */
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import {
  BACKUP_FILE_MAX_BYTES,
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  type BackupCategoryId,
  type BackupFileManifest,
  type BackupProgress,
  backupEntryName,
  backupIncludesSecrets,
  encodeBackupLine,
  sortBackupCategories,
} from '@whombat/core';
import type { BurrowRow } from '../commit/types';
import type { Db } from '../db/client';
import { iso } from '../lib/time';
import type { PrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { buildInfo } from '../version';
import { BodyWriter } from './body';
import { collectAgents } from './collect/agents';
import { collectAutomations } from './collect/automations';
import { collectConnections } from './collect/connections';
import { collectFiles } from './collect/files';
import { collectMemories } from './collect/memories';
import { collectMessages } from './collect/messages';
import { collectRepositories } from './collect/repositories';
import {
  burrowEntry,
  CategoryOut,
  CollectOut,
  type CollectScope,
  describeRefs,
  readableConversations,
} from './collect/scope';
import { collectServers } from './collect/servers';
import { collectSettings } from './collect/settings';
import { collectSkills } from './collect/skills';
import { liveSource } from './collect/source';
import { collectVault } from './collect/vault';
import { newBackupKeys } from './container';
import { backupError } from './errors';
import { madeFileName, scratchName, stagedPath } from './paths';
import { Spool } from './spool';

type Collector = (scope: CollectScope, out: CategoryOut, all: CollectOut) => Promise<void>;

export const COLLECTORS: Record<BackupCategoryId, Collector> = {
  agents: collectAgents,
  memories: collectMemories,
  automations: collectAutomations,
  connections: collectConnections,
  skills: collectSkills,
  settings: collectSettings,
  vault: collectVault,
  messages: collectMessages,
  servers: collectServers,
  files: collectFiles,
  repositories: collectRepositories,
};

export interface MakeJob {
  id: string;
  burrow: BurrowRow;
  maker: PrincipalRow;
  makerEmail: string;
  categories: BackupCategoryId[];
  /** Dropped as soon as the keys are made (never stored or logged). */
  password: string;
  /** The estimate's record count (the progress bar's first total). */
  expected: number;
  progress(p: BackupProgress): void;
}

export interface MadeFile {
  path: string;
  size: number;
  sha256: string;
  manifest: BackupFileManifest;
}

export async function makeBackupFile(services: Services, job: MakeJob): Promise<MadeFile> {
  const config = services.config;
  const scratch = stagedPath(config, scratchName(job.id));
  const finalPath = stagedPath(config, madeFileName(job.id));
  const partial = `${finalPath}.partial`;
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const categories = sortBackupCategories(job.categories);
  const outs = new Map<BackupCategoryId, CategoryOut>();
  let done = 0;
  let total = Math.max(1, job.expected);
  let step: BackupCategoryId | null = null;
  const tick = () => {
    done++;
    if (done >= total) total = done + 1;
    job.progress({ done, total, step });
  };
  const all = new CollectOut(services, tick);
  try {
    let keys = await newBackupKeys(job.password);
    job.password = '';
    const createdAt = services.clock();
    // One read-only snapshot for every category: records that refer to each other agree (BF-D05).
    await services.db.transaction(
      async (tx) => {
        const db = tx as unknown as Db;
        const visible = await readableConversations(db, job.burrow.id);
        const scope: CollectScope = {
          services,
          db,
          burrow: job.burrow,
          maker: job.maker,
          makerEmail: job.makerEmail.toLowerCase(),
          readable: visible.readable,
          categories: new Set(categories),
          scratch,
          source: liveSource(services),
        };
        all.directory.set(job.burrow.id, burrowEntry(job.burrow));
        for (const id of categories) {
          step = id;
          const spool = await Spool.create(`${scratch}/${id}.jsonl`);
          const out = new CategoryOut(id, spool, all);
          outs.set(id, out);
          await COLLECTORS[id](scope, out, all);
          await spool.close();
        }
        await describeRefs(scope, all);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    const manifest: BackupFileManifest = {
      format: BACKUP_FORMAT,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      createdAt: iso(createdAt),
      timeZone: job.burrow.timeZone || 'UTC',
      whombatVersion: (buildInfo().version || '0.0.0').slice(0, 64),
      source: {
        burrowId: job.burrow.id,
        name: job.burrow.name.slice(0, 200),
        slug: job.burrow.slug.slice(0, 63),
      },
      madeBy: { name: job.maker.name.slice(0, 200), email: job.makerEmail.toLowerCase() },
      categories: categories.map((id) => {
        const out = outs.get(id) as CategoryOut;
        return { id, count: out.count, bytes: out.bytes };
      }),
      includesSecrets: backupIncludesSecrets(categories),
      // What couldn't go in, said in the restore preview (BF-19, BF-S12).
      notes: [...all.notes.values()].slice(0, 20),
    };
    // What is left to write: the record files, then the hosts service's backup and every blob, canvas and bundle.
    total =
      done +
      categories.length +
      (all.hostsBackup ? 1 : 0) +
      all.blobs.size +
      all.canvases.size +
      all.bundles.size +
      2;
    step = null;
    job.progress({ done, total, step });

    const fh = await open(partial, 'w', 0o600);
    let made: { size: number; sha256: string };
    try {
      const writer = new BodyWriter(fh, keys, Math.floor(createdAt.getTime() / 1000));
      keys = undefined as never;
      const guard = () => {
        if (writer.written > BACKUP_FILE_MAX_BYTES) throw backupError('too_large');
      };
      await writer.file(backupEntryName.manifest, encodeBackupLine(manifest).subarray(0, -1));
      tick();
      const dir: Uint8Array[] = [];
      const first = all.directory.get(job.burrow.id);
      if (first) dir.push(encodeBackupLine(first));
      for (const [id, entry] of all.directory) if (id !== job.burrow.id) dir.push(encodeBackupLine(entry));
      await writer.file(backupEntryName.directory, Buffer.concat(dir));
      tick();
      for (const id of categories) {
        step = id;
        const out = outs.get(id) as CategoryOut;
        await writer.stream(backupEntryName.records(id), out.spool.size, out.spool.read());
        await out.spool.remove();
        tick();
        guard();
      }
      // The hosts service's backup as it gave it (BF-13), once, right after the records.
      const hostsBackup = all.hostsBackup;
      if (hostsBackup) {
        step = 'servers';
        await writer.stream(backupEntryName.hostsBackup, hostsBackup.size, hostsBackup.spool.read());
        await hostsBackup.spool.remove();
        tick();
        guard();
      }
      step = categories.includes('files') ? 'files' : null;
      for (const blob of all.blobs.values()) {
        await writer.stream(
          backupEntryName.blob(blob.sha256),
          blob.size,
          sized(await blob.open(), blob.size),
        );
        tick();
        guard();
      }
      step = categories.includes('messages') ? 'messages' : step;
      for (const [id, spool] of all.canvases) {
        await writer.stream(backupEntryName.canvas(id), spool.size, spool.read());
        await spool.remove();
        tick();
        guard();
      }
      step = categories.includes('repositories') ? 'repositories' : step;
      for (const [name, bundle] of all.bundles) {
        await writer.stream(
          backupEntryName.repository(name),
          bundle.size,
          createReadStream(bundle.path) as AsyncIterable<Uint8Array>,
        );
        await rm(bundle.path, { force: true });
        tick();
        guard();
      }
      made = await writer.finish();
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(partial, finalPath);
    return { path: finalPath, size: made.size, sha256: made.sha256, manifest };
  } catch (err) {
    await rm(partial, { force: true }).catch(() => {});
    throw err;
  } finally {
    for (const out of outs.values()) await out.spool.remove().catch(() => {});
    for (const spool of all.canvases.values()) await spool.remove().catch(() => {});
    await all.hostsBackup?.spool.remove().catch(() => {});
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** Passes exactly `size` bytes through, or fails (a blob that changed size can't be written into the archive). */
async function* sized(source: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  let n = 0;
  for await (const chunk of source) {
    n += chunk.length;
    if (n > size) throw new Error('a file is longer than recorded');
    yield chunk;
  }
  if (n !== size) throw new Error('a file is shorter than recorded');
}
