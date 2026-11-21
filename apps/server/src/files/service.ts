/**
 * Attachment files (Workstream A, docs/decisions/bp-attachments.md): the file store, the limits from config,
 * the durable orphan sweep and the mapping from rows to the contract's `Attachment`.
 *
 * The sweep (BP-A07) runs at start and every hour. It is idempotent and keeps its state in the database:
 * uploads never sent (reserved or ready without a message and not saved into Files) older than
 * `WHOMBAT_UPLOAD_ORPHAN_HOURS`, files removed from Files (`deleted`, files-space.md FS-06), and rows whose message no
 * longer exists, are deleted; then every blob no row references is removed under the blob's
 * advisory lock (the same lock an upload takes when it commits a blob), and staging files a crash left behind.
 * A person's photo (docs/decisions/person-avatars.md PVA-08) is a row without a message that is never sent: the sweep
 * leaves it while it is someone's photo, and a blob an account keeps as its photo (`accounts.avatar`) is in use. A
 * repository's icon (docs/decisions/chat-inbox.md) is such a row too, left while `repo_icons` keeps it.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Attachment } from '@whombat/core';
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Tx } from '../db/client';
import { accounts, attachments, uploadReservations } from '../db/schema/index';
import { hostPaths } from '../lib/host-paths';
import type { Services } from '../services';
import { removePreviews, sweepPreviews } from './previews';
import { blobKey, type FileStore, LocalFileStore } from './store';

/** The sha256 a blob key names (`sha256/ab/cd/<sha256>`). */
export function sha256OfKey(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

export type AttachmentRow = typeof attachments.$inferSelect;

/** How long upload reservation records are kept: the hourly rate window plus a margin. */
export const UPLOAD_RATE_KEEP_MS = 2 * 3_600_000;

/** Advisory lock class for blobs ("WHBF"): an upload committing a blob and the sweep deleting it. */
export const BLOB_LOCK_CLASS = 0x57484246;

export async function lockBlob(tx: Pick<Tx, 'execute'>, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${BLOB_LOCK_CLASS}::int, hashtext(${key}))`);
}

/** `WHOMBAT_FILES_DIR` (`~` expanded), else `$WHOMBAT_HOME/files`. */
export function filesDir(config: Pick<Config, 'WHOMBAT_FILES_DIR' | 'WHOMBAT_HOME'>): string {
  const dir = config.WHOMBAT_FILES_DIR;
  if (dir) return dir === '~' ? homedir() : dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir;
  return join(hostPaths(config).whombatHome, 'files');
}

/**
 * A row as clients see it. A thumbnail (review-features.md RF-04) is at its own path beside `url`
 * (`attachmentThumbnailUrl`), authorized like the file. `inFiles` only for a message's file (files-space.md FS-14).
 */
export function toAttachment(row: AttachmentRow, inFiles?: boolean): Attachment {
  const thumbnail = !!row.thumbnailWidth && !!row.thumbnailHeight;
  return {
    id: row.id,
    name: row.name,
    contentType: row.contentType,
    size: row.size,
    url: row.url,
    kind: row.kind,
    width: row.width ?? null,
    height: row.height ?? null,
    thumbnailUrl: thumbnail ? `${row.url}/thumbnail` : null,
    thumbnailWidth: thumbnail ? row.thumbnailWidth : null,
    thumbnailHeight: thumbnail ? row.thumbnailHeight : null,
    ...(inFiles === undefined ? {} : { inFiles }),
  };
}

export interface SweepResult {
  rows: number;
  blobs: number;
  staging: number;
}

export class AttachmentFiles {
  readonly store: FileStore;
  /** Uploads whose bytes are arriving right now (one PUT at a time per attachment). */
  readonly receiving = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #sweeping: Promise<SweepResult> | null = null;

  constructor(
    private readonly services: Pick<Services, 'config' | 'db' | 'log' | 'clock'> & {
      maintenance?: Services['maintenance'];
    },
    store?: FileStore,
  ) {
    this.store = store ?? new LocalFileStore(filesDir(services.config));
  }

  get maxBytes(): number {
    return this.services.config.WHOMBAT_UPLOAD_MAX_BYTES;
  }

  get orphanMs(): number {
    return this.services.config.WHOMBAT_UPLOAD_ORPHAN_HOURS * 3_600_000;
  }

  /** Sweeps now and every hour while the process runs. */
  start(intervalMs = 3_600_000): void {
    if (this.#timer) return;
    const run = () => {
      // A drain (a backup checkpoint's write barrier, an update) pauses file-moving work (MR-15).
      if (this.services.maintenance?.held) return;
      void this.sweep().catch((err) =>
        this.services.log.warn({ err: String(err) }, 'attachment sweep failed'),
      );
    };
    run();
    this.#timer = setInterval(run, intervalMs);
    this.#timer.unref?.();
  }

  close(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Deletes a blob no row references, under its lock (an upload may be committing the same bytes). */
  async removeIfUnused(key: string): Promise<boolean> {
    return this.services.db.transaction(async (tx) => {
      await lockBlob(tx, key);
      const [used] = await tx
        .select({ one: sql<number>`1` })
        .from(attachments)
        .where(eq(attachments.blobKey, key))
        .limit(1);
      if (used) return false;
      const [photo] = await tx
        .select({ one: sql<number>`1` })
        .from(accounts)
        .where(sql`${accounts.avatar}->>'sha256' = ${sha256OfKey(key)}`)
        .limit(1);
      if (photo) return false;
      await this.store.delete(key);
      // Its thumbnail goes with it (review-features.md RF-04).
      await removePreviews(filesDir(this.services.config), sha256OfKey(key)).catch(() => {});
      return true;
    });
  }

  /** One pass (concurrent calls share it). */
  sweep(): Promise<SweepResult> {
    this.#sweeping ??= this.#sweep().finally(() => {
      this.#sweeping = null;
    });
    return this.#sweeping;
  }

  async #sweep(): Promise<SweepResult> {
    const db = this.services.db;
    const now = this.services.clock();
    const cutoff = new Date(now.getTime() - this.orphanMs);
    // A file saved straight into Files (`filed_at`, files-space.md FS-02) is not an unsent upload: it stays until it is
    // removed from Files, which marks it `deleted` (FS-06) for this pass to take away at once.
    const unsent = await db
      .delete(attachments)
      .where(
        or(
          eq(attachments.state, 'deleted'),
          and(
            isNull(attachments.messageId),
            isNull(attachments.filedAt),
            lt(attachments.createdAt, cutoff),
            sql`not exists (select 1 from principals p where p.avatar_attachment_id = ${attachments.id})`,
            // A repository's icon for the Chat list stays while it is kept for the repository (chat-inbox.md).
            sql`not exists (select 1 from repo_icons r where r.attachment_id = ${attachments.id})`,
            // A council's pictures wait unsent until its final card (council.md CNL-31), a task's shots until its
            // delegation ends (delegate.md DLG-27).
            sql`not exists (select 1 from council_shots s where ${attachments.id} in (s.before_id, s.after_id, s.compare_id))`,
            sql`not exists (select 1 from delegation_shots s where ${attachments.id} in (s.before_id, s.after_id, s.compare_id))`,
            // Handed-over attachments from matched emails wait until their dedup row is pruned.
            sql`not exists (select 1 from mail_trigger_items m where ${attachments.id} = any(m.attachment_ids))`,
          ),
        ),
      )
      .returning({ blobKey: attachments.blobKey });
    const orphaned = await db
      .delete(attachments)
      .where(
        and(
          isNotNull(attachments.messageId),
          sql`not exists (select 1 from messages m where m.id = ${attachments.messageId})`,
        ),
      )
      .returning({ blobKey: attachments.blobKey });
    let blobs = 0;
    const candidates = new Set<string>();
    for (const r of [...unsent, ...orphaned]) if (r.blobKey) candidates.add(r.blobKey);
    for await (const blob of this.store.list()) candidates.add(blob.key);
    const keys = [...candidates];
    for (let i = 0; i < keys.length; i += 500) {
      const batch = keys.slice(i, i + 500);
      const used = new Set(
        (
          await db
            .selectDistinct({ key: attachments.blobKey })
            .from(attachments)
            .where(inArray(attachments.blobKey, batch))
        ).map((r) => r.key),
      );
      const photos = await db
        .select({ sha256: sql<string>`${accounts.avatar}->>'sha256'` })
        .from(accounts)
        .where(inArray(sql`${accounts.avatar}->>'sha256'`, batch.map(sha256OfKey)));
      for (const p of photos) used.add(blobKey(p.sha256));
      for (const key of batch) {
        if (used.has(key)) continue;
        // Re-checked under the blob's lock: an upload may be committing these very bytes right now.
        const removed = await this.removeIfUnused(key);
        if (removed) blobs++;
      }
    }
    // Reservation records only count toward the hourly rate; older ones are no longer needed.
    await db
      .delete(uploadReservations)
      .where(lt(uploadReservations.createdAt, new Date(now.getTime() - UPLOAD_RATE_KEEP_MS)));
    const staging = await this.store.sweepStaging(Math.min(this.orphanMs, 6 * 3_600_000), now.getTime());
    // Previews of bytes that are gone (managed session downloads, `previews.ts`).
    await sweepPreviews(filesDir(this.services.config), this.store).catch(() => 0);
    const result = { rows: unsent.length + orphaned.length, blobs, staging };
    if (result.rows || result.blobs || result.staging)
      this.services.log.info(result, 'attachment sweep removed unsent uploads and unused files');
    return result;
  }
}
