/**
 * Writes to a conversation's Files through the commit pipeline (docs/decisions/files-space.md FS-04…FS-06, contracts
 * CT-275): saving an upload straight into Files, saving a message's file (“Save to Files”, FS-14, CT-312), renaming and
 * moving, removing. Signed events name ids only, never file names or folders (`file.saved`, `file.updated`,
 * `file.removed`; hidden from the log like chat). Every change tells the person (`files.changed` on their `me` topic);
 * so do messages with files sent or deleted and a room cleared (`publishFilesChanged`). Saving or removing a message's file also sends that message's `message.updated`, so its
 * file shows whether it is in Files (`Attachment.inFiles`).
 */
import {
  AttachmentId,
  normalizeFilesFolder,
  SaveFileBody,
  safeDisplayName,
  topics,
  UpdateFileBody,
} from '@whombat/core';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand, type TxSession } from '../commit/types';
import type { Tx } from '../db/client';
import { attachments, messages, principals } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadMessages } from '../read/messages';
import type { AttachmentRow } from './service';
import {
  canonicalFolder,
  canRenameFile,
  canTidyFile,
  type FilesViewer,
  fileRow,
  filesFolders,
  messageFileInFiles,
  removalOf,
} from './space';

/**
 * Tells the person that a conversation's Files changed (`files.changed {conversationId}` on their `me` topic, CT-275):
 * only the person reads Files, and agents never subscribe to `me` topics.
 */
export async function publishFilesChanged(
  session: Pick<TxSession, 'tx' | 'publish'>,
  conversationId: string,
  options: { eventId?: string | null } = {},
): Promise<void> {
  const conversation = await loadConversationRow(session.tx, conversationId);
  const person = conversation ? await thePerson(session.tx, conversation.burrowId) : null;
  if (!person) return;
  session.publish(
    topics.me(person.id),
    { type: 'files.changed', conversationId },
    { eventId: options.eventId ?? null },
  );
}

const viewerOf = (ctx: ApplyContext): FilesViewer => ({
  id: ctx.actor.id,
  kind: ctx.actor.kind === 'person' ? 'person' : 'agent',
});

/** A folder from a client or a tool, normalized (FS-03); a bad one is refused with what is allowed. */
export function folderInput(raw: string): string {
  const folder = normalizeFilesFolder(raw);
  if (folder === null)
    throw badRequest('Folder names are up to 4 levels of 1–64 characters, without . or ..');
  return folder;
}

/**
 * Puts a ready upload of this conversation into its Files without a message (FS-04): `filed_at` set, the folder in the
 * spelling the conversation already uses (FS-03). Signs `file.saved` and tells the person.
 */
async function fileIntoFiles(
  tx: Tx,
  ctx: ApplyContext,
  row: Pick<AttachmentRow, 'id' | 'conversationId'>,
  folder: string,
): Promise<void> {
  const conversationId = row.conversationId as string;
  const spelled = canonicalFolder(folder, await filesFolders(tx, conversationId, row.id));
  await tx.update(attachments).set({ filedAt: ctx.now, folder: spelled }).where(eq(attachments.id, row.id));
  const event = await ctx.emit({
    type: 'file.saved',
    kind: 'Messages',
    text: null,
    where: null,
    payload: { attachmentId: row.id, conversationId },
  });
  await publishFilesChanged(ctx, conversationId, { eventId: event.id });
}

/** The kind of principal that uploaded a file (`person`, `agent`), or null when it is gone. */
async function uploaderKindOf(tx: Tx, uploadedById: string): Promise<string | null> {
  const [row] = await tx
    .select({ kind: principals.kind })
    .from(principals)
    .where(eq(principals.id, uploadedById));
  return row?.kind ?? null;
}

/** A message's file changed in Files: its message again for the room (`Attachment.inFiles`, FS-14). */
async function publishFileMessage(ctx: ApplyContext, messageId: string, eventId: string | null) {
  const [row] = await ctx.tx.select().from(messages).where(eq(messages.id, messageId));
  if (!row || row.deletedAt) return;
  const [message] = await loadMessages(ctx.tx, [row], null);
  if (message)
    ctx.publish(topics.conversation(row.conversationId), { type: 'message.updated', message }, { eventId });
}

/**
 * “Save to Files” (FS-14…FS-16): a person in the conversation puts a file of one of its live messages into its Files —
 * an agent's file, or one that was removed from Files. One already in Files is answered as it is. The file keeps its
 * message and the name it was sent with; whoever saved it may tidy it (`filed_by`); deleting the message leaves it in
 * Files as a saved file (FS-D01).
 */
async function saveMessageFile(tx: Tx, ctx: ApplyContext, row: AttachmentRow, folder: string) {
  const conversationId = row.conversationId as string;
  const [message] = await tx
    .select({ conversationId: messages.conversationId, burrowId: messages.burrowId })
    .from(messages)
    .where(and(eq(messages.id, row.messageId as string), isNull(messages.deletedAt)));
  if (!message || message.burrowId !== ctx.burrow.id || message.conversationId !== conversationId)
    throw notFound('File');
  const conversation = await loadConversationRow(tx, conversationId);
  if (!conversation) throw notFound('File');
  if (ctx.actor.kind !== 'person') throw forbidden('Agents don’t save files into Files; people do.');
  const done = { attachmentId: row.id, conversationId };
  if (messageFileInFiles(row, await uploaderKindOf(tx, row.uploadedById))) return done;
  const spelled = canonicalFolder(folder, await filesFolders(tx, conversationId, row.id));
  await tx
    .update(attachments)
    .set({
      filedAt: row.filedAt ?? ctx.now,
      filedById: ctx.actor.id,
      filesRemovedAt: null,
      filesRemovedById: null,
      folder: spelled,
    })
    .where(eq(attachments.id, row.id));
  const event = await ctx.emit({
    type: 'file.saved',
    kind: 'Messages',
    text: null,
    where: null,
    payload: { attachmentId: row.id, conversationId, messageId: row.messageId },
  });
  await publishFilesChanged(ctx, conversationId, { eventId: event.id });
  await publishFileMessage(ctx, row.messageId as string, event.id);
  return done;
}

/** The row locked for a change, if it is in Files of a conversation of the actor's burrow; else “not found”. */
async function fileForChange(tx: Tx, ctx: ApplyContext, attachmentId: string) {
  const [locked] = await tx.select().from(attachments).where(eq(attachments.id, attachmentId)).for('update');
  if (!locked || locked.burrowId !== ctx.burrow.id || !locked.conversationId) throw notFound('File');
  const file = await fileRow(tx, attachmentId);
  if (!file) throw notFound('File');
  const conversation = await loadConversationRow(tx, locked.conversationId);
  if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('File');
  return { row: file.attachment, conversation };
}

/**
 * `files.save`: a ready, unsent upload of the caller goes into its conversation's Files (FS-04); a file on a live message
 * of a conversation the caller is in, people only, too (“Save to Files”, FS-14).
 */
export const saveFile = defineCommand({
  name: 'save_file',
  schema: SaveFileBody,
  async apply(tx, ctx, input) {
    const folder = folderInput(input.folder);
    const [row] = await tx
      .select()
      .from(attachments)
      .where(eq(attachments.id, input.attachmentId))
      .for('update');
    if (!row || row.burrowId !== ctx.burrow.id || !row.conversationId || row.state === 'deleted')
      throw notFound('File');
    if (row.messageId && row.state === 'ready') return saveMessageFile(tx, ctx, row, folder);
    if (row.uploadedById !== ctx.actor.id) throw notFound('File');
    const conversation = await loadConversationRow(tx, row.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('File');
    if (row.state !== 'ready') throw conflict('That file hasn’t finished uploading.');
    if (row.messageId) throw conflict('That file is on a message already.');
    // Saving again ends where it is (a retry); a removed one stays removed.
    if (row.filedAt) {
      if (row.filesRemovedAt) throw notFound('File');
      return { attachmentId: row.id, conversationId: conversation.id };
    }
    await fileIntoFiles(tx, ctx, row, folder);
    return { attachmentId: row.id, conversationId: conversation.id };
  },
});

/** `files.update`: rename a file saved straight into Files, or move a file to another folder (FS-05). */
export const updateFile = defineCommand({
  name: 'update_file',
  schema: z.object({ attachmentId: AttachmentId }).and(UpdateFileBody),
  async apply(tx, ctx, input) {
    const { row, conversation } = await fileForChange(tx, ctx, input.attachmentId);
    const viewer = viewerOf(ctx);
    if (viewer.kind !== 'person') throw forbidden('Agents don’t rename or move files; people tidy Files.');
    const changes: { name?: string; folder?: string } = {};
    if (input.name !== undefined) {
      const name = safeDisplayName(input.name);
      if (!name) throw badRequest('Give the file a name.');
      if (name !== row.name) {
        if (!canRenameFile(row, conversation.kind, viewer))
          throw forbidden(
            row.messageId
              ? 'A file sent on a message keeps the name it was sent with.'
              : 'Only you can rename it.',
          );
        changes.name = name;
      }
    }
    if (input.folder !== undefined) {
      const folder = canonicalFolder(
        folderInput(input.folder),
        await filesFolders(tx, conversation.id, row.id),
      );
      if (folder !== row.folder) {
        if (!canTidyFile(row, conversation.kind, viewer)) throw forbidden('Only you can move it.');
        changes.folder = folder;
      }
    }
    if (!changes.name && changes.folder === undefined)
      return { attachmentId: row.id, conversationId: conversation.id };
    await tx.update(attachments).set(changes).where(eq(attachments.id, row.id));
    const event = await ctx.emit({
      type: 'file.updated',
      kind: 'Messages',
      text: null,
      where: null,
      payload: {
        attachmentId: row.id,
        conversationId: conversation.id,
        renamed: changes.name !== undefined,
        moved: changes.folder !== undefined,
      },
    });
    await publishFilesChanged(ctx, conversation.id, { eventId: event.id });
    return { attachmentId: row.id, conversationId: conversation.id };
  },
});

/**
 * `files.remove` (FS-06): a file saved straight into Files is deleted (`deleted`, its bytes go when nothing else uses
 * them); a message's file only leaves Files, the message keeps it.
 */
export const removeFile = defineCommand({
  name: 'remove_file',
  schema: z.object({ attachmentId: AttachmentId }),
  async apply(tx, ctx, input) {
    const { row, conversation } = await fileForChange(tx, ctx, input.attachmentId);
    const viewer = viewerOf(ctx);
    if (viewer.kind !== 'person') throw forbidden('Agents don’t remove files; people tidy Files.');
    if (!canTidyFile(row, conversation.kind, viewer)) throw forbidden('Only you can remove it.');
    const removal = removalOf(row, await uploaderKindOf(tx, row.uploadedById));
    const deleted = removal === 'delete';
    await tx
      .update(attachments)
      .set(
        // An agent's file on a message is only no longer saved: agents still reach it (FS-17).
        removal === 'unsave'
          ? { filedAt: null, filedById: null }
          : {
              filesRemovedAt: ctx.now,
              filesRemovedById: ctx.actor.id,
              ...(deleted ? { state: 'deleted' as const, blobKey: null } : {}),
            },
      )
      .where(eq(attachments.id, row.id));
    const key = row.blobKey;
    if (deleted && key) {
      const files = ctx.services.files;
      ctx.after(async () => {
        await files.removeIfUnused(key);
      });
    }
    const event = await ctx.emit({
      type: 'file.removed',
      kind: 'Messages',
      text: null,
      where: null,
      payload: { attachmentId: row.id, conversationId: conversation.id, deleted },
    });
    await publishFilesChanged(ctx, conversation.id, { eventId: event.id });
    if (row.messageId) await publishFileMessage(ctx, row.messageId, event.id);
    return { ok: true as const, conversationId: conversation.id };
  },
});
