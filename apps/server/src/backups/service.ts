/**
 * Backup files (docs/decisions/backup-file.md BF-01…, BF-D01…): the jobs that make and restore them, the uploads, the
 * downloads and the sweep. One service per process; jobs run in it (one file being made and one restore per burrow at a
 * time), their rows say how far they got, and `backups.changed` (on the person's `me` topic, no content, at most once a
 * second) tells the person's apps to look again. A job that was running when the server stopped is failed at start
 * (“Try again”); files and uploads go after 24 hours.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import {
  BACKUP_CATEGORY_IDS,
  BACKUP_FILE_MAX_BYTES,
  BACKUP_FILE_TTL_S,
  BACKUP_FILES_MAX,
  BACKUP_UPLOAD_TTL_S,
  BACKUP_UPLOADS_MAX,
  type BackupCategoryId,
  type BackupFileView,
  type BackupOnDifferent,
  type BackupProgress,
  type BackupRestorePreview,
  type BackupRestoreSummary,
  type BackupRestoreView,
  type BackupServersChoice,
  type BackupUploadView,
  backupFileName,
  backupFileProblem,
  backupIncludesSecrets,
  newId,
  sortBackupCategories,
  topics,
} from '@whombat/core';
import { and, count, eq, gt, inArray, lte, or } from 'drizzle-orm';
import type { BurrowAccess } from '../auth/request';
import type { BurrowRow } from '../commit/types';
import { backupFiles, backupRestores, backupUploads } from '../db/schema/index';
import { iso } from '../lib/time';
import type { PrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { estimateServers } from './collect/servers';
import { backupFileMade, setBackupDefaults } from './commands';
import { asBackupError, backupError, problemOf } from './errors';
import { estimateBackup } from './estimate';
import { makeBackupFile } from './make';
import { offeredCategories } from './offered';
import {
  ensureStaging,
  freeBytes,
  hasRoom,
  madeFileName,
  removeStaged,
  scratchName,
  stagedNames,
  stagedPath,
  uploadFileName,
} from './paths';
import { previewRestore, runRestore } from './restore/job';
import { readUpload } from './restore/read';
import {
  type BackupFileRow,
  type BackupRestoreRow,
  type BackupUploadRow,
  listOwn,
  ownFile,
  ownRestore,
  ownUpload,
  requirePerson,
  toDefaults,
  toFileView,
  toRestoreView,
  toUploadView,
} from './store';

/** How often expired files and uploads are swept. */
export const BACKUP_SWEEP_MS = 10 * 60_000;
/** Restores are kept this long (their summaries are small). */
const RESTORES_KEEP_MS = 30 * 24 * 3600_000;
/** Progress at most once a second (CT-335). */
const PROGRESS_MS = 1000;

export class BackupService {
  readonly #jobs = new Map<string, { promise: Promise<void>; abort: AbortController }>();
  readonly #progressAt = new Map<string, number>();
  #ticker: (() => void) | null = null;

  constructor(private readonly services: Services) {}

  /** At start: jobs a stopped server left running fail (“Try again”); then the sweep, every 10 minutes. */
  start(): void {
    if (this.#ticker) return;
    void this.recover().catch((err) =>
      this.services.log.warn({ err: String(err) }, 'backup files: recovery failed'),
    );
    this.#ticker = this.services.housekeeping.add('backup files', BACKUP_SWEEP_MS, () => this.sweep(), {
      first: 'tick',
    });
  }

  close(): void {
    this.#ticker?.();
    this.#ticker = null;
    for (const job of this.#jobs.values()) job.abort.abort();
  }

  /** Waits for the jobs running now (tests, shutdown). */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.#jobs.values()].map((j) => j.promise));
  }

  /* Bookkeeping -------------------------------------------------------------------------------------- */

  private write<R>(fn: Parameters<Services['pipeline']['transactAccount']>[0]): Promise<R> {
    return this.services.pipeline.transactAccount(fn) as Promise<R>;
  }

  private changed(principalId: string, kind: 'file' | 'restore', id: string): void {
    this.services.bus.publish({
      topic: topics.me(principalId),
      event: { type: 'backups.changed', kind, id },
      eventId: null,
      at: iso(this.services.clock()),
      outboxId: null,
    });
  }

  /** A job's progress, kept and told at most once a second. */
  private progress(table: 'file' | 'restore', id: string, principalId: string, p: BackupProgress): void {
    const now = Date.now();
    if (now - (this.#progressAt.get(id) ?? 0) < PROGRESS_MS) return;
    this.#progressAt.set(id, now);
    const t = table === 'file' ? backupFiles : backupRestores;
    void this.write(async (tx) => {
      await tx.update(t).set({ progress: p }).where(eq(t.id, id));
    })
      .then(() => this.changed(principalId, table, id))
      .catch(() => {});
  }

  /** Marks what a stopped server left running as failed, and removes scratch nobody owns. */
  async recover(): Promise<{ files: number; restores: number }> {
    const now = this.services.clock();
    const expires = new Date(now.getTime() + BACKUP_FILE_TTL_S * 1000);
    const running = new Set(this.#jobs.keys());
    const { files, restores } = await this.write<{ files: BackupFileRow[]; restores: BackupRestoreRow[] }>(
      async (tx) => {
        const making = (await tx.select().from(backupFiles).where(eq(backupFiles.status, 'making'))).filter(
          (r) => !running.has(r.id),
        );
        for (const r of making)
          await tx
            .update(backupFiles)
            .set({ status: 'failed', error: backupFileProblem('failed'), progress: null, expiresAt: expires })
            .where(eq(backupFiles.id, r.id));
        const restoring = (
          await tx.select().from(backupRestores).where(eq(backupRestores.status, 'restoring'))
        ).filter((r) => !running.has(r.id));
        for (const r of restoring) {
          await tx
            .update(backupRestores)
            .set({
              status: 'failed',
              error: backupFileProblem('restore_failed'),
              progress: null,
              finishedAt: now,
            })
            .where(eq(backupRestores.id, r.id));
          // Its upload stays for “Try again” (BF-D10).
          if (r.uploadId)
            await tx
              .update(backupUploads)
              .set({ status: 'uploaded' })
              .where(eq(backupUploads.id, r.uploadId));
        }
        return { files: making, restores: restoring };
      },
    );
    for (const r of files) await removeStaged(this.services.config, scratchName(r.id)).catch(() => {});
    for (const r of restores) await removeStaged(this.services.config, scratchName(r.id)).catch(() => {});
    await this.removeOrphans();
    return { files: files.length, restores: restores.length };
  }

  /** Staged names no row owns (a crash between writing and recording) go. */
  private async removeOrphans(): Promise<void> {
    const names = await stagedNames(this.services.config);
    if (names.length === 0) return;
    const fileIds = new Set(
      (await this.services.db.select({ id: backupFiles.id }).from(backupFiles)).map((r) => r.id),
    );
    const uploadIds = new Set(
      (await this.services.db.select({ id: backupUploads.id }).from(backupUploads)).map((r) => r.id),
    );
    for (const name of names) {
      const id = name.split('.')[0]?.replace(/-inspect$/, '') ?? '';
      if (this.#jobs.has(id) || fileIds.has(id) || uploadIds.has(id)) {
        if (name.endsWith('.work') && !this.#jobs.has(id) && !name.includes('-inspect'))
          await removeStaged(this.services.config, name).catch(() => {});
        continue;
      }
      await removeStaged(this.services.config, name).catch(() => {});
    }
  }

  /** Files and uploads past their 24 hours go (with their bytes); old restores' rows too. */
  async sweep(): Promise<{ files: number; uploads: number }> {
    if (this.services.maintenance.paused) return { files: 0, uploads: 0 };
    const now = this.services.clock();
    const busyUploads = new Set<string>();
    for (const id of this.#jobs.keys()) {
      const [r] = await this.services.db
        .select({ upload: backupRestores.uploadId })
        .from(backupRestores)
        .where(eq(backupRestores.id, id));
      if (r?.upload) busyUploads.add(r.upload);
    }
    const gone = await this.write<{ files: BackupFileRow[]; uploads: BackupUploadRow[] }>(async (tx) => {
      const files = await tx
        .delete(backupFiles)
        .where(and(lte(backupFiles.expiresAt, now), inArray(backupFiles.status, ['ready', 'failed'])))
        .returning();
      const expired = (await tx.select().from(backupUploads).where(lte(backupUploads.expiresAt, now))).filter(
        (u) => !busyUploads.has(u.id),
      );
      if (expired.length)
        await tx.delete(backupUploads).where(
          inArray(
            backupUploads.id,
            expired.map((u) => u.id),
          ),
        );
      await tx
        .delete(backupRestores)
        .where(lte(backupRestores.startedAt, new Date(now.getTime() - RESTORES_KEEP_MS)));
      return { files, uploads: expired };
    });
    for (const f of gone.files) await removeStaged(this.services.config, f.path).catch(() => {});
    for (const u of gone.uploads) await removeStaged(this.services.config, u.path).catch(() => {});
    if (gone.files.length || gone.uploads.length)
      this.services.log.info(
        { files: gone.files.length, uploads: gone.uploads.length },
        'backup files: expired ones removed',
      );
    return { files: gone.files.length, uploads: gone.uploads.length };
  }

  /* Defaults and estimate ----------------------------------------------------------------------------- */

  /** The categories this Whombat can put in a file for the burrow (servers only where it watches them, BF-13). */
  offered(burrowId: string): Promise<BackupCategoryId[]> {
    return offeredCategories(this.services, burrowId);
  }

  /** The burrow's ticks, without what this Whombat can't offer (BF-13, BF-21, CT-901). */
  async defaults(access: BurrowAccess) {
    requirePerson(access);
    return toDefaults(access.burrow, await this.offered(access.burrow.id));
  }

  /** The estimate of every category, the servers' from the hosts service. */
  private async estimateFor(burrow: BurrowRow, person: PrincipalRow) {
    return estimateBackup(this.services.db, burrow, person, await estimateServers(this.services, burrow.id));
  }

  async setDefaults(access: BurrowAccess, categories: BackupCategoryId[]) {
    const person = requirePerson(access);
    const result = await this.services.pipeline.commit(
      setBackupDefaults,
      { categories },
      { burrowId: access.burrow.id, actorId: person.id },
    );
    if (result.status !== 'ok') throw backupError('people_only');
    return result.result;
  }

  async estimate(access: BurrowAccess) {
    const person = requirePerson(access);
    return {
      categories: await this.estimateFor(access.burrow, person),
      freeBytes: await freeBytes(this.services.config),
      maxBytes: BACKUP_FILE_MAX_BYTES,
      generatedAt: iso(this.services.clock()),
    };
  }

  async list(access: BurrowAccess) {
    const person = requirePerson(access);
    const own = await listOwn(this.services.db, access.burrow.id, person.id, this.services.clock());
    return {
      files: own.files.map((f) => toFileView(f, access.burrow.slug)),
      uploads: own.uploads.map((u) => toUploadView(u, access.burrow.slug)),
      restores: own.restores.map(toRestoreView),
    };
  }

  /* Making a file -------------------------------------------------------------------------------------- */

  private async emailOf(person: PrincipalRow): Promise<string> {
    if (person.email) return person.email.toLowerCase();
    return `${person.handle}@example.com`;
  }

  async create(
    access: BurrowAccess,
    input: { categories: BackupCategoryId[]; password: string },
  ): Promise<BackupFileView> {
    const person = requirePerson(access);
    const burrow = access.burrow;
    // What this Whombat can't offer is left out (servers where it watches none, BF-13; BF-S32).
    const offered = new Set(await this.offered(burrow.id));
    const categories = sortBackupCategories(input.categories).filter((id) => offered.has(id));
    if (categories.length === 0) throw backupError('nothing_chosen');
    const now = this.services.clock();
    const held = await this.services.db
      .select({ status: backupFiles.status })
      .from(backupFiles)
      .where(
        and(
          eq(backupFiles.burrowId, burrow.id),
          or(
            eq(backupFiles.status, 'making'),
            and(eq(backupFiles.status, 'ready'), gt(backupFiles.expiresAt, now)),
          ),
        ),
      );
    if (held.some((h) => h.status === 'making')) throw backupError('busy');
    if (held.length >= BACKUP_FILES_MAX) throw backupError('too_many');
    const estimate = await this.estimateFor(burrow, person);
    const bytes = estimate.filter((e) => categories.includes(e.id)).reduce((s, e) => s + e.bytes, 0);
    if (bytes > BACKUP_FILE_MAX_BYTES) throw backupError('too_large');
    // The file and, while it is made, its records twice over (spools), with room to spare.
    if (!(await hasRoom(this.services.config, Math.ceil(bytes * 1.5)))) throw backupError('no_room');
    const expected = estimate.filter((e) => categories.includes(e.id)).reduce((s, e) => s + e.count, 0);
    const id = newId('backupFile');
    const row = await this.write<BackupFileRow>(async (tx) => {
      const [made] = await tx
        .insert(backupFiles)
        .values({
          id,
          burrowId: burrow.id,
          madeById: person.id,
          name: backupFileName(burrow.slug, iso(now), burrow.timeZone || 'UTC'),
          status: 'making',
          categories,
          includesSecrets: backupIncludesSecrets(categories),
          progress: { done: 0, total: Math.max(1, expected), step: null },
          createdAt: now,
        })
        .returning();
      return made as BackupFileRow;
    });
    await ensureStaging(this.services.config);
    const abort = new AbortController();
    const makerEmail = await this.emailOf(person);
    const promise = this.make(row, burrow, person, makerEmail, input.password, expected, abort.signal);
    this.#jobs.set(id, { promise, abort });
    void promise.finally(() => {
      this.#jobs.delete(id);
      this.#progressAt.delete(id);
    });
    return toFileView(row, burrow.slug);
  }

  private async make(
    row: BackupFileRow,
    burrow: BurrowRow,
    maker: PrincipalRow,
    makerEmail: string,
    password: string,
    expected: number,
    signal: AbortSignal,
  ): Promise<void> {
    const services = this.services;
    try {
      const made = await makeBackupFile(services, {
        id: row.id,
        burrow,
        maker,
        makerEmail,
        categories: row.categories,
        password,
        expected,
        progress: (p) => {
          if (signal.aborted) throw new Error('removed while it was being made');
          this.progress('file', row.id, maker.id, p);
        },
      });
      if (signal.aborted) {
        await removeStaged(services.config, madeFileName(row.id));
        return;
      }
      const now = services.clock();
      await this.write(async (tx) => {
        await tx
          .update(backupFiles)
          .set({
            status: 'ready',
            progress: null,
            size: made.size,
            sha256: made.sha256,
            path: madeFileName(row.id),
            readyAt: now,
            expiresAt: new Date(now.getTime() + BACKUP_FILE_TTL_S * 1000),
          })
          .where(eq(backupFiles.id, row.id));
      });
      await services.pipeline
        .commit(
          backupFileMade,
          { fileId: row.id, categories: row.categories, size: made.size },
          { burrowId: burrow.id, actorId: maker.id },
        )
        .catch((err) => services.log.warn({ err: String(err) }, 'backup file: its signed event failed'));
    } catch (err) {
      if (!signal.aborted)
        services.log.warn(
          { err: String(err), stack: (err as Error)?.stack, fileId: row.id },
          'backup file: making it failed',
        );
      const now = services.clock();
      await this.write(async (tx) => {
        await tx
          .update(backupFiles)
          .set({
            status: 'failed',
            progress: null,
            error: problemOf(err, 'failed'),
            expiresAt: new Date(now.getTime() + BACKUP_FILE_TTL_S * 1000),
          })
          .where(eq(backupFiles.id, row.id));
      }).catch((e) =>
        services.log.warn({ err: String(e), fileId: row.id }, 'backup file: saving that it failed failed'),
      );
    } finally {
      this.changed(maker.id, 'file', row.id);
    }
  }

  async get(access: BurrowAccess, id: string): Promise<BackupFileView> {
    const person = requirePerson(access);
    const row = await ownFile(this.services.db, access.burrow.id, person.id, id);
    if (row.expiresAt && row.expiresAt <= this.services.clock()) throw backupError('expired');
    return toFileView(row, access.burrow.slug);
  }

  async remove(access: BurrowAccess, id: string): Promise<{ ok: true }> {
    const person = requirePerson(access);
    const row = await ownFile(this.services.db, access.burrow.id, person.id, id);
    this.#jobs.get(row.id)?.abort.abort();
    await this.write(async (tx) => {
      await tx.delete(backupFiles).where(eq(backupFiles.id, row.id));
    });
    await removeStaged(this.services.config, row.path ?? madeFileName(row.id)).catch(() => {});
    this.changed(person.id, 'file', row.id);
    return { ok: true };
  }

  /** A ready, unexpired file of the caller's, for its bytes. */
  async downloadable(
    burrowId: string,
    principal: PrincipalRow,
    id: string,
  ): Promise<{ row: BackupFileRow; path: string }> {
    if (principal.kind !== 'person') throw backupError('people_only');
    const row = await ownFile(this.services.db, burrowId, principal.id, id);
    // Not ready (still being made, or failed) or past its 24 hours: there are no bytes to give.
    if (row.status !== 'ready' || !row.path || !row.size || !row.sha256) throw backupError('expired');
    if (row.expiresAt && row.expiresAt <= this.services.clock()) throw backupError('expired');
    const path = stagedPath(this.services.config, row.path);
    const size = await stat(path).then(
      (s) => s.size,
      () => null,
    );
    if (size !== row.size) throw backupError('expired');
    return { row, path };
  }

  /* Uploads -------------------------------------------------------------------------------------------- */

  async stage(
    access: BurrowAccess,
    input: { fileName: string; size: number; sha256?: string | undefined },
  ): Promise<BackupUploadView> {
    const person = requirePerson(access);
    if (input.size > BACKUP_FILE_MAX_BYTES) throw backupError('too_large');
    const now = this.services.clock();
    const [{ n } = { n: 0 }] = await this.services.db
      .select({ n: count() })
      .from(backupUploads)
      .where(
        and(
          eq(backupUploads.burrowId, access.burrow.id),
          eq(backupUploads.uploadedById, person.id),
          inArray(backupUploads.status, ['uploading', 'uploaded']),
          gt(backupUploads.expiresAt, now),
        ),
      );
    if (n >= BACKUP_UPLOADS_MAX) throw backupError('too_many');
    // The upload, and what a restore unpacks of it (files, bundles) beside it.
    if (!(await hasRoom(this.services.config, input.size * 2))) throw backupError('no_room');
    await ensureStaging(this.services.config);
    const id = newId('stagedBackup');
    const path = uploadFileName(id);
    const fh = await open(stagedPath(this.services.config, path), 'w', 0o600);
    await fh.close();
    const row = await this.write<BackupUploadRow>(async (tx) => {
      const [made] = await tx
        .insert(backupUploads)
        .values({
          id,
          burrowId: access.burrow.id,
          uploadedById: person.id,
          fileName: input.fileName.trim().slice(0, 255),
          size: input.size,
          sha256: input.sha256 ?? null,
          received: 0,
          status: 'uploading',
          path,
          createdAt: now,
          expiresAt: new Date(now.getTime() + BACKUP_UPLOAD_TTL_S * 1000),
        })
        .returning();
      return made as BackupUploadRow;
    });
    return toUploadView(row, access.burrow.slug);
  }

  /** One of the caller's uploads that isn't used or expired. */
  async liveUpload(burrowId: string, principal: PrincipalRow, id: string): Promise<BackupUploadRow> {
    if (principal.kind !== 'person') throw backupError('people_only');
    const row = await ownUpload(this.services.db, burrowId, principal.id, id);
    if (row.status === 'used' || row.expiresAt <= this.services.clock()) throw backupError('upload_expired');
    return row;
  }

  async getUpload(access: BurrowAccess, id: string): Promise<BackupUploadView> {
    const person = requirePerson(access);
    return toUploadView(await this.liveUpload(access.burrow.id, person, id), access.burrow.slug);
  }

  async removeUpload(access: BurrowAccess, id: string): Promise<{ ok: true }> {
    const person = requirePerson(access);
    const row = await ownUpload(this.services.db, access.burrow.id, person.id, id);
    const [running] = await this.services.db
      .select({ id: backupRestores.id })
      .from(backupRestores)
      .where(and(eq(backupRestores.uploadId, row.id), eq(backupRestores.status, 'restoring')));
    if (running) throw backupError('restore_running');
    await this.write(async (tx) => {
      await tx.delete(backupUploads).where(eq(backupUploads.id, row.id));
    });
    await removeStaged(this.services.config, row.path).catch(() => {});
    return { ok: true };
  }

  /**
   * One chunk of a REST upload (`BACKUP_FILE_TRANSFER.upload`): it must start where the upload is (`received`) and
   * name the staged size; a chunk that already arrived (the same bytes) answers the current state. After the last
   * chunk the whole file is checked (its sha256 when it was staged with one).
   */
  async receiveChunk(
    burrow: BurrowRow,
    principal: PrincipalRow,
    id: string,
    range: { start: number; end: number; size: number },
    data: Buffer,
    chunkSha256: string | null,
  ): Promise<BackupUploadView> {
    let row = await this.liveUpload(burrow.id, principal, id);
    if (range.size !== row.size || data.length !== range.end - range.start)
      throw backupError('upload_mismatch', { received: row.received });
    if (chunkSha256 && createHash('sha256').update(data).digest('hex') !== chunkSha256)
      throw backupError('upload_mismatch', { received: row.received });
    const path = stagedPath(this.services.config, row.path);
    if (range.end <= row.received) {
      // Sent again after a lost answer: the same bytes are already here.
      const fh = await open(path, 'r');
      try {
        const have = Buffer.alloc(data.length);
        await fh.read(have, 0, data.length, range.start);
        if (!have.equals(data)) throw backupError('upload_mismatch', { received: row.received });
      } finally {
        await fh.close();
      }
      return toUploadView(row, burrow.slug);
    }
    if (row.status !== 'uploading' || range.start !== row.received)
      throw backupError('upload_mismatch', { received: row.received });
    const fh = await open(path, 'r+');
    try {
      await fh.truncate(row.received);
      await fh.write(data, 0, data.length, range.start);
      await fh.sync();
    } finally {
      await fh.close();
    }
    const received = range.end;
    row = await this.write<BackupUploadRow>(async (tx) => {
      const [r] = await tx
        .update(backupUploads)
        .set({ received })
        .where(and(eq(backupUploads.id, row.id), eq(backupUploads.received, row.received)))
        .returning();
      if (!r) throw backupError('upload_mismatch', { received: row.received });
      return r;
    });
    if (received === row.size) row = await this.finishUpload(row);
    return toUploadView(row, burrow.slug);
  }

  /** The whole file is here: its sha256 checked (against the announced one) and the upload `uploaded`. */
  async finishUpload(row: BackupUploadRow, sessionSha256?: string): Promise<BackupUploadRow> {
    const path = stagedPath(this.services.config, row.path);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
    const sha256 = hash.digest('hex');
    if (
      size !== row.size ||
      (row.sha256 && row.sha256 !== sha256) ||
      (sessionSha256 && sessionSha256 !== sha256)
    ) {
      // Start again from the beginning: what arrived isn't the file that was announced.
      const fh = await open(path, 'r+');
      await fh.truncate(0);
      await fh.close();
      await this.write(async (tx) => {
        await tx
          .update(backupUploads)
          .set({ received: 0, status: 'uploading' })
          .where(eq(backupUploads.id, row.id));
      });
      throw backupError('upload_mismatch', { received: 0 });
    }
    return this.write<BackupUploadRow>(async (tx) => {
      const [r] = await tx
        .update(backupUploads)
        .set({ status: 'uploaded', sha256, received: size, uploadedAt: this.services.clock() })
        .where(eq(backupUploads.id, row.id))
        .returning();
      return r as BackupUploadRow;
    });
  }

  /**
   * A session upload's target (`UploadTarget {type: 'backup-file'}`): the staged size (and sha256, when staged with
   * one) must match; the bytes go straight into the upload's staged file.
   */
  async sessionTarget(
    burrowId: string,
    principal: PrincipalRow,
    id: string,
    spec: { size: number; sha256?: string },
  ): Promise<{
    key: string;
    size: number;
    path: string;
    complete: (sha256: string | undefined) => Promise<unknown>;
  }> {
    const row = await this.liveUpload(burrowId, principal, id);
    if (
      row.status !== 'uploading' ||
      row.size !== spec.size ||
      (row.sha256 && spec.sha256 && row.sha256 !== spec.sha256)
    )
      throw backupError('upload_mismatch', { received: row.received });
    return {
      key: row.id,
      size: row.size,
      path: stagedPath(this.services.config, row.path),
      complete: async (sha256) => {
        const done = await this.finishUpload(row, sha256);
        return { stagedBackupId: done.id, size: done.size, sha256: done.sha256 };
      },
    };
  }

  /* Inspect and restore ----------------------------------------------------------------------------------- */

  private uploadedRow(row: BackupUploadRow): void {
    if (row.status !== 'uploaded') throw backupError('upload_incomplete');
  }

  async inspect(access: BurrowAccess, id: string, password: string): Promise<BackupRestorePreview> {
    const person = requirePerson(access);
    const row = await this.liveUpload(access.burrow.id, person, id);
    this.uploadedRow(row);
    const config = this.services.config;
    const scratchId = `${row.id}-inspect-${newId('stagedBackup').slice(4, 10)}`;
    const scratch = stagedPath(config, scratchName(scratchId));
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    try {
      const read = await readUpload(stagedPath(config, row.path), password, {
        scratch,
        keep: new Set(BACKUP_CATEGORY_IDS),
        keepBytes: false,
      });
      try {
        return await previewRestore({
          services: this.services,
          burrow: access.burrow,
          restorer: person,
          restorerEmail: await this.emailOf(person),
          read,
          fileName: row.fileName,
          size: row.size,
        });
      } finally {
        for (const s of read.spools.values()) await s.spool.remove().catch(() => {});
      }
    } catch (err) {
      throw asBackupError(err);
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  async restore(
    access: BurrowAccess,
    id: string,
    input: {
      password: string;
      categories: BackupCategoryId[];
      onDifferent: BackupOnDifferent;
      servers?: BackupServersChoice | undefined;
    },
  ): Promise<BackupRestoreView> {
    const person = requirePerson(access);
    const burrow = access.burrow;
    const row = await this.liveUpload(burrow.id, person, id);
    this.uploadedRow(row);
    const categories = sortBackupCategories(input.categories);
    if (categories.length === 0) throw backupError('nothing_chosen');
    const [running] = await this.services.db
      .select({ id: backupRestores.id })
      .from(backupRestores)
      .where(and(eq(backupRestores.burrowId, burrow.id), eq(backupRestores.status, 'restoring')));
    if (running) throw backupError('restore_running');
    if (!(await hasRoom(this.services.config, row.size))) throw backupError('no_room');
    const config = this.services.config;
    const restoreId = newId('backupRestore');
    const scratch = stagedPath(config, scratchName(restoreId));
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    // The whole file is read (and checked) before anything is restored: a damaged one changes nothing.
    let read: Awaited<ReturnType<typeof readUpload>>;
    try {
      read = await readUpload(stagedPath(config, row.path), input.password, {
        scratch,
        keep: new Set(categories),
        keepBytes: true,
      });
    } catch (err) {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
      throw asBackupError(err);
    }
    const inFile = new Set(read.manifest.categories.map((c) => c.id));
    if (categories.some((c) => !inFile.has(c))) {
      for (const s of read.spools.values()) await s.spool.remove().catch(() => {});
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
      throw backupError('not_in_file');
    }
    const now = this.services.clock();
    // Reading the file took minutes: the upload is this restore's only if nobody took it meanwhile, and the index of
    // one running restore per burrow refuses a second one started at the same time (backup-options.md).
    const restoreRow = await this.write<BackupRestoreRow | null>(async (tx) => {
      const [taken] = await tx
        .update(backupUploads)
        .set({ status: 'used' })
        .where(and(eq(backupUploads.id, row.id), eq(backupUploads.status, 'uploaded')))
        .returning({ id: backupUploads.id });
      if (!taken) return null;
      const [made] = await tx
        .insert(backupRestores)
        .values({
          id: restoreId,
          burrowId: burrow.id,
          restoredById: person.id,
          uploadId: row.id,
          fileName: row.fileName,
          madeAt: new Date(read.manifest.createdAt),
          sourceName: read.manifest.source.name,
          sourceBurrowId: read.manifest.source.burrowId,
          categories,
          onDifferent: input.onDifferent,
          status: 'restoring',
          progress: { done: 0, total: 1, step: null },
          startedAt: now,
        })
        .returning();
      return made as BackupRestoreRow;
    }).catch((err: unknown) => {
      if (isUniqueViolation(err, RESTORE_ONE_RUNNING)) return null;
      throw err;
    });
    if (!restoreRow) {
      for (const s of read.spools.values()) await s.spool.remove().catch(() => {});
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
      throw backupError('restore_running');
    }
    const abort = new AbortController();
    const restorerEmail = await this.emailOf(person);
    const promise = (async () => {
      let summary: BackupRestoreSummary | null = null;
      let failed: unknown = null;
      try {
        summary = await runRestore({
          services: this.services,
          restoreId,
          burrow,
          restorer: person,
          restorerEmail,
          read,
          categories,
          onDifferent: input.onDifferent,
          servers: input.servers,
          scratch,
          progress: (p) => this.progress('restore', restoreId, person.id, p),
        });
      } catch (err) {
        failed = err;
        summary = (err as { partial?: BackupRestoreSummary }).partial ?? null;
        this.services.log.warn(
          { err: String(err), stack: (err as Error)?.stack, restoreId },
          'backup restore failed',
        );
      } finally {
        for (const s of read.spools.values()) await s.spool.remove().catch(() => {});
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
      }
      const finishedAt = this.services.clock();
      await this.write(async (tx) => {
        await tx
          .update(backupRestores)
          .set({
            status: failed ? 'failed' : 'done',
            progress: null,
            summary,
            error: failed ? problemOf(failed, 'restore_failed') : null,
            finishedAt,
            uploadId: failed ? row.id : null,
          })
          .where(eq(backupRestores.id, restoreId));
        // Done, the upload has done its work (BF-10) and goes; a failed restore keeps it for “Try again” (BF-D10).
        if (failed)
          await tx.update(backupUploads).set({ status: 'uploaded' }).where(eq(backupUploads.id, row.id));
        else await tx.delete(backupUploads).where(eq(backupUploads.id, row.id));
      }).catch((err) =>
        // A restore left “restoring” holds back every later one: this must be seen.
        this.services.log.warn({ err: String(err), restoreId }, 'backup restore: saving how it ended failed'),
      );
      if (!failed) await removeStaged(config, row.path).catch(() => {});
      this.changed(person.id, 'restore', restoreId);
    })();
    this.#jobs.set(restoreId, { promise, abort });
    void promise.finally(() => {
      this.#jobs.delete(restoreId);
      this.#progressAt.delete(restoreId);
    });
    return toRestoreView(restoreRow);
  }

  async getRestore(access: BurrowAccess, id: string): Promise<BackupRestoreView> {
    const person = requirePerson(access);
    return toRestoreView(await ownRestore(this.services.db, access.burrow.id, person.id, id));
  }
}

/** The index that keeps one backup-file restore running per burrow (migration 0038). */
const RESTORE_ONE_RUNNING = 'backup_restores_one_running';

/** Whether `err` (or the database error it wraps) is a unique violation of `constraint`. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const pg = e as { code?: unknown; constraint?: unknown; constraint_name?: unknown };
    if (pg.code === '23505' && (pg.constraint === constraint || pg.constraint_name === constraint))
      return true;
  }
  return false;
}

export function backupsFor(services: Services): BackupService {
  const s = services as Services & { backupFiles?: BackupService };
  s.backupFiles ??= new BackupService(services);
  return s.backupFiles;
}
