/**
 * A page set's thumbnail (docs/decisions/page-sets.md): the picture of the page it opens on, `.whombat/cover.png` in
 * the set, made into the set's thumbnail the way an image's is (`files/previews.ts`, kept under the set's own sha256), so
 * clients load it as any thumbnail: `Attachment.thumbnailUrl`, the session download's `preview` variant.
 */
import { readFile } from 'node:fs/promises';
import { isPageSet } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { attachments } from '../db/schema/index';
import { attachmentPreview, type PreviewResult, previewPath } from '../files/previews';
import type { AttachmentRow } from '../files/service';
import { filesDir } from '../files/service';
import { sniffBuffer } from '../files/sniff';
import type { Services } from '../services';
import { pageSetCover } from './set';

type SetRow = Pick<AttachmentRow, 'sha256' | 'blobKey' | 'size' | 'contentType'>;

/** The set's thumbnail: made once from its cover, then read from where it is kept. */
export async function pageSetPreview(services: Services, row: SetRow): Promise<PreviewResult> {
  if (!isPageSet(row) || !row.sha256 || !row.blobKey) return { ok: false, reason: 'unsupported' };
  const root = filesDir(services.config);
  const kept = await readFile(previewPath(root, row.sha256, 'image/png')).catch(() => null);
  const cover = kept ? null : await pageSetCover(services.files.store, row);
  if (!kept && !cover) return { ok: false, reason: 'unsupported' };
  const sniffed = cover ? sniffBuffer(cover, 'cover.png') : null;
  const dims = sniffed?.ok && sniffed.value.contentType === 'image/png' ? sniffed.value : null;
  if (cover && !dims) return { ok: false, reason: 'unsupported' };
  return attachmentPreview({
    filesRoot: root,
    store: services.files.store,
    images: services.feedback.images,
    source: {
      sha256: row.sha256,
      blobKey: row.blobKey,
      contentType: 'image/png',
      // A kept thumbnail is read before the size matters; a cover is a screenshot (1280×800).
      width: dims?.width ?? 1280,
      height: dims?.height ?? 800,
      size: cover?.length ?? 0,
      read: async () => cover,
    },
  });
}

/** Makes a just-kept set's thumbnail and records its size; the row as it is then. Never throws. */
export async function makePageSetThumbnail(services: Services, row: AttachmentRow): Promise<AttachmentRow> {
  if (row.thumbnailWidth) return row;
  try {
    const made = await pageSetPreview(services, row);
    if (!made.ok || !made.preview.width || !made.preview.height) return row;
    const { width, height } = made.preview;
    const [updated] = await services.pipeline.transactAccount((tx) =>
      tx
        .update(attachments)
        .set({ thumbnailWidth: width, thumbnailHeight: height })
        .where(eq(attachments.id, row.id))
        .returning(),
    );
    return updated ?? row;
  } catch (err) {
    services.log.warn({ err: String(err), attachmentId: row.id }, 'could not make a page set’s thumbnail');
    return row;
  }
}
