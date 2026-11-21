/**
 * The attachment MCP tools (docs/decisions/bp-attachments.md BP-A10, BP-A11): `read_attachment` reads a text
 * attachment the dispatch may use, a chunk at a time; `upload_file` publishes an agent's artifact into a
 * conversation it may post in (then `post_message` / `reply_in_thread` attach it with `attachmentIds`).
 */
import {
  ARTIFACT_MAX_BYTES,
  type AttachmentKind,
  FILES_LIST_MAX,
  normalizeFilesFolder,
  safeDisplayName,
} from '@whombat/core';
import { badRequest, notFound } from '../lib/errors';
import type { ToolHandler } from '../mcp/tools';
import { loadPrincipalsByIds } from '../read/principals';
import { WINDOW_SIZE } from '../runtime/context';
import { dispatchReadableAttachment, dispatchSeesFiles } from './access';
import { publishArtifact, tooLarge } from './commands';
import { toAttachment } from './service';
import { sniffBuffer } from './sniff';
import { listFileRows } from './space';
import { makeThumbnail } from './thumbnails';

const KIND_TEXT: Record<AttachmentKind, string> = {
  image: 'an image',
  text: 'a text file',
  document: 'a PDF',
  file: 'a file of a type Whombat can’t open',
};

/** The UTF-8 text of `bytes`, cut back to the last whole character; how many bytes that used. */
export function wholeUtf8(bytes: Buffer, atEnd: boolean): { text: string; used: number } {
  let end = bytes.length;
  if (!atEnd) {
    // Step back over a character cut in half (at most 3 continuation bytes after its lead byte).
    let i = end - 1;
    let continuation = 0;
    while (i >= 0 && continuation < 4 && ((bytes[i] as number) & 0xc0) === 0x80) {
      i--;
      continuation++;
    }
    if (i >= 0) {
      const lead = bytes[i] as number;
      const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (need > continuation + 1) end = i;
    }
  }
  return { text: bytes.subarray(0, end).toString('utf8'), used: end };
}

async function readRange(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(parts);
}

const readAttachment: ToolHandler<'read_attachment'> = async (ctx, input) => {
  const row = await dispatchReadableAttachment(
    ctx.services.db,
    ctx.dispatch,
    WINDOW_SIZE,
    input.attachmentId,
  );
  if (!row) throw notFound('Attachment');
  const attachment = {
    id: row.id,
    name: row.name,
    contentType: row.contentType,
    kind: row.kind,
    size: row.size,
  };
  if (row.kind !== 'text' || !row.blobKey) {
    return {
      status: 'ok',
      attachment,
      text: null,
      offset: input.offset,
      nextOffset: null,
      note: `${row.name} is ${KIND_TEXT[row.kind]}; it can’t be read as text here.`,
    };
  }
  let offset = Math.min(input.offset, row.size);
  if (offset >= row.size)
    return {
      status: 'ok',
      attachment,
      text: '',
      offset,
      nextOffset: null,
      note: 'That is the end of the file.',
    };
  const end = Math.min(row.size, offset + input.maxBytes) - 1;
  const stream = await ctx.services.files.store.open(row.blobKey, { start: offset, end });
  if (!stream) throw notFound('Attachment');
  let bytes = await readRange(stream);
  // An offset inside a character starts at the next whole one.
  let skip = 0;
  while (skip < bytes.length && skip < 3 && ((bytes[skip] as number) & 0xc0) === 0x80) skip++;
  bytes = bytes.subarray(skip);
  offset += skip;
  const atEnd = end + 1 >= row.size;
  const { text, used } = wholeUtf8(bytes, atEnd);
  const next = offset + used;
  return {
    status: 'ok',
    attachment,
    text,
    offset,
    nextOffset: next >= row.size ? null : next,
    note: null,
  };
};

const BASE64 = /^[A-Za-z0-9+/\r\n]*={0,2}\s*$/;

const uploadFile: ToolHandler<'upload_file'> = async (ctx, input) => {
  if ((input.text === undefined) === (input.contentBase64 === undefined))
    throw badRequest('Give either text or contentBase64.');
  if (input.contentBase64 !== undefined && !BASE64.test(input.contentBase64))
    throw badRequest('contentBase64 is not valid base64.');
  const bytes =
    input.text !== undefined
      ? Buffer.from(input.text, 'utf8')
      : Buffer.from(input.contentBase64 ?? '', 'base64');
  if (bytes.length === 0) throw badRequest('The file is empty.');
  const files = ctx.services.files;
  const max = Math.min(ARTIFACT_MAX_BYTES, files.maxBytes);
  if (bytes.length > max) throw tooLarge('file', max);
  const name = safeDisplayName(input.name);
  const sniffed = sniffBuffer(bytes, name);
  if (!sniffed.ok)
    throw badRequest(
      sniffed.reason === 'image_too_large'
        ? 'That image is too large.'
        : 'That image is damaged or not an image.',
    );
  const staged = await files.store.stage([bytes], { maxBytes: max });
  let kept = false;
  try {
    const result = await ctx.services.pipeline.commit(
      publishArtifact,
      {
        conversationId: input.conversationId,
        name,
        declaredType: input.contentType ?? '',
        staged: { token: staged.token, size: staged.size, sha256: staged.sha256 },
        sniffed: sniffed.value,
      },
      { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf },
    );
    if (result.status !== 'ok') {
      // No key guards publishing, so the pipeline never asks or blocks here; answer like any tool if it did.
      return result.status === 'blocked'
        ? { status: 'blocked', keyNeeded: result.keyNeeded, eventId: result.eventId, message: result.message }
        : {
            status: 'pending_approval',
            approvalId: result.approvalId,
            approvalNumber: result.approvalNumber,
            eventId: result.eventId,
            message: result.message,
          };
    }
    kept = true;
    // An image's thumbnail before the agent posts it (review-features.md RF-04).
    const stored = await makeThumbnail(ctx.services, result.result);
    return { status: 'ok', attachmentId: stored.id, attachment: toAttachment(stored) };
  } finally {
    if (!kept) await files.store.discard(staged).catch(() => {});
  }
};

/**
 * `list_files` (files-space.md FS-11): the Files of this turn's conversation only (FS-08), newest first, at most
 * `FILES_LIST_MAX`; a folder narrows it to that folder and the ones in it. None in a search answer or an assessment.
 */
const listFiles: ToolHandler<'list_files'> = async (ctx, input) => {
  const db = ctx.services.db;
  const folder = input.folder ? normalizeFilesFolder(input.folder) : '';
  if (folder === null)
    throw badRequest('Folder names are up to 4 levels of 1–64 characters, without . or ..');
  if (!dispatchSeesFiles(ctx.dispatch)) return { status: 'ok', files: [], truncated: false };
  const { rows, more } = await listFileRows(db, ctx.dispatch.conversationId, {
    limit: FILES_LIST_MAX,
    forAgents: true,
    ...(folder ? { folder } : {}),
  });
  const names = new Map(
    (await loadPrincipalsByIds(db, [...new Set(rows.map((r) => r.attachment.uploadedById))])).map((p) => [
      p.id,
      p.name,
    ]),
  );
  return {
    status: 'ok',
    files: rows.map(({ attachment: a, addedAt }) => ({
      attachmentId: a.id,
      name: a.name,
      folder: a.folder,
      size: a.size,
      contentType: a.contentType,
      kind: a.kind,
      uploadedBy: names.get(a.uploadedById) ?? 'Someone',
      addedAt: addedAt.toISOString(),
    })),
    truncated: more,
  };
};

export const ATTACHMENT_TOOL_HANDLERS = {
  read_attachment: readAttachment,
  upload_file: uploadFile,
  list_files: listFiles,
};
