/**
 * `show_pages` (docs/decisions/page-sets.md): the agent shows the person a folder of pages as one file on a message.
 * The turn's runner reads the folder (only it reads the turn's folder), draws the page it opens on for the cover, packs
 * the set and sends its bytes (`routes.ts`); here it is kept as the agent's file in the conversation (a page set's
 * type, up to any file's limit), its thumbnail made from the cover, and — with `replaces` — put in the earlier set's
 * place on its message. The agent posts it with `post_message` `attachmentIds` otherwise. No key of its own: it shows
 * only the agent's own files, in the conversation it is in, like `upload_file`.
 */
import {
  cleanPagePath,
  type McpToolOutput,
  PAGES_CONTENT_TYPE,
  PAGES_DEFAULT_OPEN,
  pageSetFileName,
} from '@whombat/core';
import { previewsFor } from '../browser/previews';
import { publishArtifact } from '../files/commands';
import { ApiError } from '../lib/errors';
import { withImage } from '../mcp/image';
import type { ToolHandler } from '../mcp/tools';
import { NOT_YOUR_SET, replaceableSet, replacePageSet } from './commands';
import { makePageSetThumbnail } from './cover';
import { pageSetCover } from './set';

type Answer = McpToolOutput<'show_pages'>;

const refused = (reason: string): Answer => ({ status: 'refused', reason: reason.slice(0, 500) });

const showPages: ToolHandler<'show_pages'> = async (ctx, input): Promise<Answer> => {
  const open = cleanPagePath((input.open ?? PAGES_DEFAULT_OPEN).replace(/^\/+/, ''));
  if (!open) return refused('Name the page it opens on inside the folder, like index.html.');
  const title = input.title.trim();
  if (!title) return refused('Give the pages a title of a few words.');
  const where = { burrowId: ctx.burrowId, agentId: ctx.agentId, conversationId: ctx.dispatch.conversationId };
  if (input.replaces && !(await replaceableSet(ctx.services.db, where, input.replaces)))
    return refused(NOT_YOUR_SET);
  const files = ctx.services.files;
  const upload = await previewsFor(ctx.services).requestPages(ctx.dispatch.id, input.folder, { open, title });
  if ('error' in upload) return refused(upload.error);
  if (!('pages' in upload)) return { status: 'failed', reason: 'The runner sent something else.' };
  const { staged, manifest } = upload.pages;
  const opts = { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf };
  let kept = false;
  let row: Awaited<ReturnType<typeof publishArtifact.apply>>;
  try {
    const result = await ctx.services.pipeline.commit(
      publishArtifact,
      {
        conversationId: ctx.dispatch.conversationId,
        name: pageSetFileName(manifest.title),
        declaredType: PAGES_CONTENT_TYPE,
        staged: { token: staged.token, size: staged.size, sha256: staged.sha256 },
        sniffed: { kind: 'file', contentType: PAGES_CONTENT_TYPE, width: null, height: null },
        limit: 'pages',
      },
      opts,
    );
    if (result.status !== 'ok') return refused('These pages couldn’t be kept here.');
    kept = true;
    row = result.result;
  } catch (err) {
    // A size, quota, rate or conversation refusal: its words, never a stack.
    return refused(err instanceof ApiError ? err.message : 'These pages couldn’t be kept.');
  } finally {
    if (!kept) await files.store.discard(staged).catch(() => {});
  }
  if (manifest.cover) row = await makePageSetThumbnail(ctx.services, row);

  let messageId: string | undefined;
  if (input.replaces) {
    try {
      const replaced = await ctx.services.pipeline.commit(
        replacePageSet,
        { replaces: input.replaces, attachmentId: row.id, conversationId: ctx.dispatch.conversationId },
        opts,
      );
      if (replaced.status !== 'ok') return refused('The earlier pages couldn’t be replaced.');
      messageId = replaced.result.messageId;
    } catch (err) {
      return refused(
        `${err instanceof ApiError ? err.message : 'The earlier pages couldn’t be replaced.'} Post these with attachmentIds instead: ${row.id}.`,
      );
    }
  }

  const answer: Answer = {
    status: 'ok',
    attachmentId: row.id,
    name: row.name,
    files: manifest.files,
    pages: manifest.pages,
    bytes: staged.size,
    problems: manifest.problems,
    ...(messageId ? { messageId } : {}),
  };
  // The agent sees the cover it is showing.
  const cover = manifest.cover ? await pageSetCover(files.store, row).catch(() => null) : null;
  return cover ? withImage(answer, cover.toString('base64')) : answer;
};

export const PAGES_TOOL_HANDLERS: { show_pages: ToolHandler<'show_pages'> } = { show_pages: showPages };
