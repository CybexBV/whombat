/**
 * Bringing back what the person picked from an opened backup (backup-look.md): the backup file's collectors read the
 * picked things from the backup's database and folders (one read-only snapshot, only the picked records kept), their
 * bytes are copied into the job's scratch, and the backup file's restorer brings them back the way it restores a file
 * into the Whombat it came from — only adding: anything here already stays as it is. Every write goes through the
 * commit pipeline (the restore's batches), and each picked thing is told back as back, here already, or not back.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  type BackupCategoryId,
  type BackupFileManifest,
  type BackupRestoreSummary,
  backupIncludesSecrets,
  newId,
  sortBackupCategories,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import type { BurrowRow } from '../../commit/types';
import type { Db } from '../../db/client';
import { backupRestores } from '../../db/schema/index';
import { iso } from '../../lib/time';
import type { PrincipalRow } from '../../read/principals';
import type { Services } from '../../services';
import { buildInfo } from '../../version';
import {
  burrowEntry,
  CategoryOut,
  CollectOut,
  type CollectScope,
  describeRefs,
  readableConversations,
} from '../collect/scope';
import { backupError, problemOf } from '../errors';
import { COLLECTORS } from '../make';
import { runRestore } from '../restore/job';
import { type ReadUpload, wantedBytes } from '../restore/read';
import { isUniqueViolation } from '../service';
import { Spool, spooledLines } from '../spool';
import {
  type ItemOutcome,
  itemOutcome,
  keysOfItem,
  type LookPick,
  type Outcome,
  type PickedItem,
  PickFilter,
  pickedCategories,
  pickedConversations,
} from './pick';
import { peekSource } from './source';

export interface BringJob {
  services: Services;
  lookId: string;
  burrow: BurrowRow;
  person: PrincipalRow;
  personEmail: string;
  /** The backup's database and folders. */
  peek: Db;
  root: string;
  /** When the backup was made. */
  madeAt: Date;
  pick: LookPick;
  /** The picked things as the backup has them (title, a thread's conversation, a chat's or thread's messages). */
  found: readonly { item: PickedItem; title: string; messageIds: readonly string[] }[];
  /** The job's own scratch directory (removed at the end). */
  scratch: string;
}

export interface BringOutcome {
  back: number;
  already: number;
  notBack: number;
  /** What came back, by title. */
  titles: string[];
  /** Connections that came back and need the person to sign in again. */
  signIn: string[];
  summary: BackupRestoreSummary | null;
}

/** The index that keeps one restore running per burrow (a file's or a look's). */
const ONE_RUNNING = 'backup_restores_one_running';

/** Reads the picked records from the backup into spools, with the directory of what they refer to. */
async function collectPicked(job: BringJob, collectDir: string) {
  const { services, pick } = job;
  const categories = pickedCategories(pick);
  const filter = new PickFilter(pick);
  const all = new CollectOut(services, () => {});
  const outs = new Map<BackupCategoryId, CategoryOut>();
  await job.peek.transaction(
    async (tx) => {
      const db = tx as unknown as Db;
      const only = pickedConversations(pick);
      const readable = only ?? (await readableConversations(db, job.burrow.id)).readable;
      const scope: CollectScope = {
        services,
        db,
        burrow: job.burrow,
        maker: job.person,
        makerEmail: job.personEmail.toLowerCase(),
        readable,
        // A chat's files come with its messages, whether or not Files was picked.
        categories: new Set<BackupCategoryId>([
          ...categories,
          ...(categories.includes('messages') ? (['files'] as const) : []),
        ]),
        scratch: collectDir,
        source: peekSource(db, job.root, collectDir),
      };
      all.directory.set(job.burrow.id, burrowEntry(job.burrow));
      for (const id of categories) {
        const spool = await Spool.create(join(collectDir, `${id}.jsonl`));
        const out = new CategoryOut(id, spool, all, (value) => filter.keep(id, value));
        outs.set(id, out);
        await COLLECTORS[id](scope, out, all);
        await spool.close();
      }
      await describeRefs(scope, all);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  return { all, outs };
}

/** Copies one blob into the restore's scratch, checked against its sha256 and size; false when the backup lacks it. */
async function copyBlob(
  source: { size: number; open(): Promise<AsyncIterable<Uint8Array>> },
  sha256: string,
  path: string,
): Promise<boolean> {
  let stream: AsyncIterable<Uint8Array>;
  try {
    stream = await source.open();
  } catch {
    return false;
  }
  const fh = await open(path, 'w', 0o600);
  const hash = createHash('sha256');
  let n = 0;
  try {
    for await (const chunk of stream) {
      hash.update(chunk);
      n += chunk.length;
      await fh.write(chunk);
    }
  } finally {
    await fh.close();
  }
  if (n !== source.size || hash.digest('hex') !== sha256) {
    await rm(path, { force: true });
    return false;
  }
  return true;
}

export async function bringBack(job: BringJob): Promise<BringOutcome> {
  const { burrow, person } = job;
  const collectDir = join(job.scratch, 'collect');
  const restoreDir = join(job.scratch, 'restore');
  await mkdir(collectDir, { recursive: true, mode: 0o700 });
  await mkdir(restoreDir, { recursive: true, mode: 0o700 });
  let collected: Awaited<ReturnType<typeof collectPicked>> | null = null;
  try {
    collected = await collectPicked(job, collectDir);
    const { all, outs } = collected;
    // The bytes the kept records point to: blobs and canvases, into the restore's scratch as the restorer reads them.
    const wanted = new Set<string>();
    const spools = new Map<BackupCategoryId, { spool: Spool; lines: number }>();
    for (const [id, out] of outs) {
      if (out.lines === 0) continue;
      spools.set(id, { spool: out.spool, lines: out.lines });
      for await (const line of spooledLines(out.spool)) wantedBytes(id, line, wanted);
    }
    const blobs = new Set<string>();
    for (const w of wanted) {
      if (w.startsWith('blob:')) {
        const sha = w.slice('blob:'.length);
        const source = all.blobs.get(sha);
        if (source && (await copyBlob(source, sha, join(restoreDir, `blob-${sha}`)))) blobs.add(sha);
      } else if (w.startsWith('canvas:')) {
        const id = w.slice('canvas:'.length);
        const spool = all.canvases.get(id);
        if (!spool || !/^cvs_[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
        const fh = await open(join(restoreDir, `canvas-${id}`), 'w', 0o600);
        try {
          for await (const chunk of spool.read()) await fh.write(chunk);
        } finally {
          await fh.close();
        }
      }
    }
    const categories = sortBackupCategories([...spools.keys()]);
    const outcomes = new Map<string, Outcome[]>();
    let summary: BackupRestoreSummary | null = null;
    if (categories.length) {
      const manifest: BackupFileManifest = {
        format: BACKUP_FORMAT,
        schemaVersion: BACKUP_SCHEMA_VERSION,
        createdAt: iso(job.madeAt),
        timeZone: burrow.timeZone || 'UTC',
        whombatVersion: (buildInfo().version || '0.0.0').slice(0, 64),
        source: { burrowId: burrow.id, name: burrow.name.slice(0, 200), slug: burrow.slug.slice(0, 63) },
        madeBy: { name: person.name.slice(0, 200), email: job.personEmail.toLowerCase() },
        categories: categories.map((id) => {
          const out = outs.get(id) as CategoryOut;
          return { id, count: out.count, bytes: out.bytes };
        }),
        includesSecrets: backupIncludesSecrets(categories),
        notes: [...all.notes.values()].slice(0, 20),
      };
      const read: ReadUpload = {
        manifest,
        directory: all.directory,
        unreadableDirectory: 0,
        spools,
        blobs,
        hostsBackup: null,
      };
      summary = await restore(job, read, categories, restoreDir, (key, outcome) =>
        outcomes.set(key, [...(outcomes.get(key) ?? []), outcome]),
      );
    }
    const results: ItemOutcome[] = [];
    const titles: string[] = [];
    for (const f of job.found) {
      const keys = keysOfItem(f.item, () => f.messageIds);
      const o = itemOutcome(keys.flatMap((k) => outcomes.get(k) ?? []));
      results.push(o);
      if (o === 'back' && titles.length < 10) titles.push(f.title);
    }
    return {
      back: results.filter((r) => r === 'back').length,
      already: results.filter((r) => r === 'already').length,
      notBack: results.filter((r) => r === 'not_back').length,
      titles,
      signIn: (summary?.connectionsToSignIn ?? []).map((c) => c.label).slice(0, 10),
      summary,
    };
  } finally {
    if (collected) {
      for (const out of collected.outs.values()) await out.spool.remove().catch(() => {});
      for (const spool of collected.all.canvases.values()) await spool.remove().catch(() => {});
    }
    await rm(job.scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** The restore itself: its row (the look's, never listed with a file's), the restorer, and how it ended. */
async function restore(
  job: BringJob,
  read: ReadUpload,
  categories: BackupCategoryId[],
  scratch: string,
  onOutcome: (key: string, outcome: Outcome) => void,
): Promise<BackupRestoreSummary> {
  const { services, burrow, person } = job;
  const restoreId = newId('backupRestore');
  const now = services.clock();
  const made = await services.pipeline
    .transactAccount(async (tx) => {
      await tx.insert(backupRestores).values({
        id: restoreId,
        burrowId: burrow.id,
        restoredById: person.id,
        // The look in place of an upload: what was brought back from a backup the box opened (not a file's restore).
        uploadId: job.lookId,
        fileName: `Backup of ${iso(job.madeAt).slice(0, 10)}`,
        madeAt: job.madeAt,
        sourceName: burrow.name.slice(0, 200),
        sourceBurrowId: burrow.id,
        categories,
        onDifferent: 'keep',
        status: 'restoring',
        progress: { done: 0, total: 1, step: null },
        startedAt: now,
      });
      return true;
    })
    .catch((err: unknown) => {
      if (isUniqueViolation(err, ONE_RUNNING)) return false;
      throw err;
    });
  if (!made) throw backupError('restore_running');
  let summary: BackupRestoreSummary | null = null;
  let failed: unknown = null;
  try {
    summary = await runRestore({
      services,
      restoreId,
      burrow,
      restorer: person,
      restorerEmail: job.personEmail,
      read,
      categories,
      onDifferent: 'keep',
      scratch,
      progress: () => {},
      onOutcome,
    });
  } catch (err) {
    failed = err;
    summary = (err as { partial?: BackupRestoreSummary }).partial ?? null;
    services.log.warn({ err: String(err), restoreId }, 'backup look: bringing things back failed');
  }
  await services.pipeline
    .transactAccount(async (tx) => {
      await tx
        .update(backupRestores)
        .set({
          status: failed ? 'failed' : 'done',
          progress: null,
          summary,
          error: failed ? problemOf(failed, 'restore_failed') : null,
          finishedAt: services.clock(),
        })
        .where(eq(backupRestores.id, restoreId));
    })
    .catch(() => {});
  if (failed) throw failed;
  return summary as BackupRestoreSummary;
}
