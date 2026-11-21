/**
 * Image thumbnails (docs/decisions/review-features.md RF-04; contracts 0.55.0 CT-298): when a PNG or JPEG upload is
 * stored — a person's upload over REST or a session, an agent's `upload_file` — and it is larger than
 * `THUMBNAIL_MAX_EDGE` (720) on its longest side, the image worker makes its thumbnail (the content-addressed preview,
 * `previews.ts`) before the upload is answered, and the attachment records the thumbnail's size: `Attachment
 * .thumbnailUrl`, `thumbnailWidth`, `thumbnailHeight`. Images within the edge are their own thumbnail (none is made),
 * other files have none, and an image the worker can't do keeps none: clients fall back to `url`.
 *
 * The size is derived data, written as operational bookkeeping (`transactAccount`, no signed event: the upload's own
 * `attachment.uploaded` is the record). The bytes go with the blob they were made from.
 */
import { THUMBNAIL_MAX_EDGE } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { attachments } from '../db/schema/index';
import type { Services } from '../services';
import { attachmentPreview, PREVIEW_MAX_SOURCE_BYTES, PREVIEW_MAX_SOURCE_PIXELS } from './previews';
import { type AttachmentRow, filesDir } from './service';

/** Whether a stored attachment gets a thumbnail: a PNG or JPEG larger than the edge, within the worker's budget. */
export function wantsThumbnail(
  row: Pick<AttachmentRow, 'contentType' | 'width' | 'height' | 'size' | 'blobKey' | 'sha256'>,
): boolean {
  if (row.contentType !== 'image/png' && row.contentType !== 'image/jpeg') return false;
  if (!row.blobKey || !row.sha256 || !row.width || !row.height) return false;
  if (Math.max(row.width, row.height) <= THUMBNAIL_MAX_EDGE) return false;
  return row.width * row.height <= PREVIEW_MAX_SOURCE_PIXELS && row.size <= PREVIEW_MAX_SOURCE_BYTES;
}

/**
 * Makes the thumbnail of a just-stored attachment and records its size. Returns the row as it is then (as given when it
 * gets none). Never throws: a thumbnail that can't be made is a file without one.
 */
export async function makeThumbnail(services: Services, row: AttachmentRow): Promise<AttachmentRow> {
  if (!wantsThumbnail(row) || row.thumbnailWidth) return row;
  try {
    const made = await attachmentPreview({
      filesRoot: filesDir(services.config),
      store: services.files.store,
      images: services.feedback.images,
      source: {
        sha256: row.sha256 as string,
        blobKey: row.blobKey as string,
        contentType: row.contentType,
        width: row.width,
        height: row.height,
        size: row.size,
      },
    });
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
    services.log.warn({ err: String(err), attachmentId: row.id }, 'could not make a thumbnail');
    return row;
  }
}
