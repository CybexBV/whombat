/**
 * The Files endpoints (docs/decisions/files-space.md FS-04, contracts CT-275), for REST and the session alike: the
 * summary for the sidebar, one conversation's listing, and save / update / remove through the commit pipeline. Any
 * conversation or file the caller isn't in is “not found”.
 */
import { api } from '@whombat/core';
import { badRequest, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { commitAs } from '../routes/burrows';
import { route } from '../routes/define';
import type { Services } from '../services';
import {
  decodeFilesCursor,
  encodeFilesCursor,
  fileRow,
  filesSummaryRows,
  listFileRows,
  toFileEntry,
} from './space';
import { removeFile, saveFile, updateFile } from './space-commands';

type Access = { burrow: { id: string }; principal: { id: string; kind: string } };

/** The conversation, when it is one of the caller's burrow; else “not found”. */
async function burrowConversation(services: Services, access: Access, conversationId: string) {
  const row = await loadConversationRow(services.db, conversationId);
  if (!row || row.burrowId !== access.burrow.id) throw notFound('Conversation');
  return row;
}

/** One file as the caller sees it after a change. */
async function entryFor(services: Services, access: Access, attachmentId: string, conversationId: string) {
  await burrowConversation(services, access, conversationId);
  const file = await fileRow(services.db, attachmentId);
  if (!file) throw notFound('File');
  return toFileEntry(file);
}

export const filesRoutes = [
  route(api.files.summary, async ({ access, services }) => {
    const rows = await filesSummaryRows(services.db, access.burrow.id);
    return {
      conversations: rows.map((r) => ({
        conversationId: r.conversationId,
        count: r.count,
        bytes: r.bytes,
        lastAddedAt: r.lastAddedAt.toISOString(),
      })),
    };
  }),

  route(api.files.list, async ({ access, params, query, services }) => {
    const conversation = await burrowConversation(services, access, params.conversationId);
    const cursor = query.cursor ? decodeFilesCursor(query.cursor) : null;
    if (query.cursor && !cursor) throw badRequest('That page of files doesn’t exist. Start from the top.');
    const { rows, more } = await listFileRows(services.db, conversation.id, { limit: query.limit, cursor });
    const last = rows.at(-1);
    return {
      files: rows.map((r) => toFileEntry(r)),
      nextCursor: more && last ? encodeFilesCursor({ at: last.addedAt, id: last.attachment.id }) : null,
    };
  }),

  route(api.files.save, async (ctx) => {
    const saved = await commitAs(ctx, saveFile, ctx.body);
    return { file: await entryFor(ctx.services, ctx.access, saved.attachmentId, saved.conversationId) };
  }),

  route(api.files.update, async (ctx) => {
    const updated = await commitAs(ctx, updateFile, { ...ctx.body, attachmentId: ctx.params.attachmentId });
    return { file: await entryFor(ctx.services, ctx.access, updated.attachmentId, updated.conversationId) };
  }),

  route(api.files.remove, async (ctx) => {
    await commitAs(ctx, removeFile, { attachmentId: ctx.params.attachmentId });
    return { ok: true as const };
  }),
];
