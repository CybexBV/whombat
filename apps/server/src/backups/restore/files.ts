/**
 * Restoring Files (BF-04): a file on a message that came back is already here (the messages put it in Files as it
 * was); any other one comes back saved straight into its conversation's Files, in its folder, with its bytes from the
 * backup (one copy per sha256 in the file store).
 */
import { attachmentUrl, type BackupFileRecord, type BackupFilesLine, newId } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { attachments } from '../../db/schema/index';
import { blobKey } from '../../files/store';
import { storeBlob } from './messages';
import type { RecordOutcome, RestoreRun } from './run';

export async function restoreFiles(run: RestoreRun, record: BackupFilesLine): Promise<RecordOutcome> {
  return file(run, record);
}

async function file(run: RestoreRun, r: BackupFileRecord): Promise<RecordOutcome> {
  const mapped = run.mapped(r.id);
  if (mapped) {
    if (run.dry || run.isStandIn(mapped)) return 'unchanged';
    const [row] = await run.tx.select().from(attachments).where(eq(attachments.id, mapped));
    if (row && !row.filedAt) {
      await run.tx
        .update(attachments)
        .set({ filedAt: new Date(r.addedAt), folder: r.folder })
        .where(eq(attachments.id, row.id));
    }
    return 'unchanged';
  }
  if (run.sameBurrow) {
    const [same] = await run.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(and(eq(attachments.id, r.id), eq(attachments.burrowId, run.burrow.id)));
    if (same) {
      run.remember(r.id, same.id, 'file');
      return 'unchanged';
    }
  }
  const conversationId = await run.resolve(r.conversation);
  if (!conversationId || !run.hasBlob(r.sha256)) {
    run.note('missing_reference', 'files');
    return 'skipped';
  }
  if (run.dry) return 'added';
  const path = run.blobPath(r.sha256);
  if (run.isStandIn(conversationId) || !path) return 'skipped';
  const uploader = await run.resolve(r.uploadedBy);
  const filer = await run.resolve(r.filedBy);
  const who = (id: string | null) => (id && !run.isStandIn(id) ? id : run.restorer.id);
  await storeBlob(run, r.sha256, r.size, path);
  const id = newId('attachment');
  const addedAt = new Date(r.addedAt);
  await run.tx.insert(attachments).values({
    id,
    burrowId: run.burrow.id,
    conversationId,
    name: r.name,
    contentType: r.contentType,
    kind: r.kind,
    size: r.size,
    sha256: r.sha256,
    blobKey: blobKey(r.sha256),
    width: r.width,
    height: r.height,
    state: 'ready',
    url: attachmentUrl(run.burrow.slug, id),
    uploadedById: who(uploader),
    // Saved straight into Files: its message (when it had one) didn't come back.
    messageId: null,
    createdAt: addedAt,
    uploadedAt: addedAt,
    folder: r.folder,
    filedAt: addedAt,
    filedById: who(filer ?? uploader),
  });
  run.remember(r.id, id, 'file');
  run.touched.add(conversationId);
  return 'added';
}
