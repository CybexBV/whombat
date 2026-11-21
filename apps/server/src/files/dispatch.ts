/**
 * `DispatchContext.attachments` (Workstream A): the ready attachments on the messages a dispatch shows its
 * agent, as references the runner fetches through the runner protocol. Never storage paths (BP-04).
 */
import { type AttachmentRef, type DispatchFiles, FILES_DISPATCH_MAX, type Message } from '@whombat/core';
import type { Db } from '../db/client';
import { dispatchAttachmentRows, dispatchSeesFiles, toAttachmentRef } from './access';
import { filesTotals, listFileRows, toFileRef } from './space';

export async function dispatchAttachments(
  db: Db,
  row: Parameters<typeof dispatchAttachmentRows>[1],
  windowSize: number,
  /**
   * The messages the context actually delivers (trigger, window, thread after memory's budget): only their
   * attachments are listed, so the agent is never offered a file of a message it was not shown.
   */
  delivered?: readonly Pick<Message, 'id'>[],
): Promise<AttachmentRef[]> {
  const rows = await dispatchAttachmentRows(db, row, windowSize);
  const shown = delivered ? new Set(delivered.map((m) => m.id)) : null;
  return rows
    .filter((r) => !shown || (r.messageId !== null && shown.has(r.messageId)))
    .map((r) => toAttachmentRef(r, row.conversationId));
}

/**
 * `DispatchContext.files` (docs/decisions/files-space.md FS-08): the Files of the dispatch's conversation only, newest
 * first, at most `FILES_DISPATCH_MAX` (`truncated` beyond); totals cover them all. Null where the agent gets no Files: a
 * search answer or a feedback assessment (FS-D03).
 */
export async function dispatchFiles(
  db: Db,
  row: Parameters<typeof dispatchAttachmentRows>[1],
): Promise<DispatchFiles | null> {
  if (!dispatchSeesFiles(row)) return null;
  const { rows, more } = await listFileRows(db, row.conversationId, {
    limit: FILES_DISPATCH_MAX,
    forAgents: true,
  });
  const totals = more
    ? await filesTotals(db, row.conversationId, true)
    : { count: rows.length, bytes: rows.reduce((n, r) => n + r.attachment.size, 0) };
  return {
    conversationId: row.conversationId,
    count: totals.count,
    totalBytes: totals.bytes,
    truncated: more,
    entries: rows.map(toFileRef),
  };
}
