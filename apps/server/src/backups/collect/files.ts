/**
 * Files (`files.jsonl`, BF-05): what is in the Files of the conversations the maker may read (saved straight into Files,
 * or a message's file in Files), each with its bytes under `files/<sha256>` once however often it is used. The bytes
 * of the included messages' files come with this category too (registered by the messages collector).
 */
import type { BackupFilesLine } from '@whombat/core';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { attachments, messages } from '../../db/schema/index';
import { addedAtSql, inFiles } from '../../files/space';
import { iso } from '../../lib/time';
import type { CategoryOut, CollectScope } from './scope';

const rec = (v: BackupFilesLine) => v as BackupFilesLine & { type: string } & Record<string, unknown>;

export async function collectFiles(scope: CollectScope, out: CategoryOut): Promise<void> {
  const { db, burrow, source } = scope;
  const ids = [...scope.readable];
  if (ids.length === 0) return;
  let after = '';
  for (;;) {
    const page = await db
      .select({ a: attachments, addedAt: addedAtSql })
      .from(attachments)
      .leftJoin(messages, eq(messages.id, attachments.messageId))
      .where(
        and(
          eq(attachments.burrowId, burrow.id),
          inArray(attachments.conversationId, ids),
          inFiles(),
          gt(attachments.id, after),
        ),
      )
      .orderBy(asc(attachments.id))
      .limit(500);
    if (page.length === 0) break;
    after = page[page.length - 1]?.a.id ?? after;
    for (const { a, addedAt } of page) {
      if (!a.sha256 || !a.blobKey || !a.conversationId) continue;
      const key = a.blobKey;
      out.blob({
        sha256: a.sha256,
        size: a.size,
        open: async () => {
          const s = await source.openBlob(key);
          if (!s) throw new Error('a file’s bytes are missing from the file store');
          return s;
        },
      });
      out.ref(a.conversationId, a.uploadedById, a.filedById, a.messageId);
      await out.record(
        rec({
          type: 'file',
          id: a.id,
          conversation: a.conversationId,
          message: a.messageId ?? null,
          name: a.name.slice(0, 255),
          contentType: a.contentType,
          kind: a.kind,
          size: a.size,
          sha256: a.sha256,
          width: a.width ?? null,
          height: a.height ?? null,
          folder: a.folder ?? '',
          uploadedBy: a.uploadedById,
          filedBy: a.filedById ?? null,
          addedAt: iso(new Date(addedAt)),
        }),
      );
    }
    if (page.length < 500) break;
  }
}
