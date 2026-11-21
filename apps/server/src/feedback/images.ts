/**
 * Screenshots of a feedback submission (docs/decisions/feedback.md FB-08). A visitor's bytes are never stored as
 * sent: each one is decoded from strict base64, sniffed (PNG or JPEG only; the declared type must agree, the name is
 * ignored), its header dimensions are checked **before** anything is decoded, then it is fully decoded with pure-JS
 * decoders under memory caps, one at a time in a worker thread (`image-pool.ts`), and **re-encoded** (PNG → PNG,
 * JPEG → JPEG q 90). Re-encoding drops every metadata chunk or segment (EXIF, XMP, text chunks) and any trailing or
 * polyglot payload.
 *
 * Refused: SVG, GIF, WebP, HTML, executables, anything else; truncated or malformed images; headers claiming more
 * than `FEEDBACK_IMAGE_MAX_SIDE` a side or `FEEDBACK_IMAGE_MAX_PIXELS` (decompression bombs).
 */
import { createHash } from 'node:crypto';
import { FEEDBACK_IMAGE_MAX_PIXELS, FEEDBACK_IMAGE_MAX_SIDE, type FeedbackSubmission } from '@whombat/core';
import { sniffBuffer } from '../files/sniff';
import { FeedbackPublicFailure } from './errors';
import { ImageJobError, type ImageRunner } from './image-pool';
import type { ScreenshotType } from './image-worker';

export {
  checkInterlacedPng,
  JPEG_MAX_MEMORY_MB,
  JPEG_QUALITY,
  pngThroughIend,
  reencode,
  type ScreenshotType,
} from './image-worker';

/** A screenshot as sent (decoded from base64), with the hash the idempotency key uses. */
export interface OriginalScreenshot {
  index: number;
  bytes: Buffer;
  /** sha256 of the bytes the visitor sent (FB-10: the payload hash covers screenshots by their hash). */
  sha256: string;
  declaredType: ScreenshotType;
}

/** A screenshot as it is stored: re-encoded bytes, sniffed type, real dimensions, a generated name. */
export interface ProcessedScreenshot {
  index: number;
  bytes: Buffer;
  sha256: string;
  originalSha256: string;
  contentType: ScreenshotType;
  width: number;
  height: number;
  name: string;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Strictly decodes each attachment (canonical base64 only) and checks the count and the per-file byte limit. No image
 * work happens here: this is what the idempotency lookup needs.
 */
export function decodeScreenshots(
  attachments: FeedbackSubmission['attachments'],
  limits: { maxAttachments: number; maxAttachmentBytes: number },
): OriginalScreenshot[] {
  if (attachments.length > limits.maxAttachments)
    throw new FeedbackPublicFailure('invalid', { fields: ['attachments'] });
  return attachments.map((a, index) => {
    const field = `attachments.${index}`;
    const data = a.data;
    if (data.length % 4 !== 0 || !BASE64.test(data))
      throw new FeedbackPublicFailure('invalid', { fields: [`${field}.data`] });
    // Cheap bound before allocating: 4 base64 characters carry 3 bytes.
    if ((data.length / 4) * 3 - 2 > limits.maxAttachmentBytes)
      throw new FeedbackPublicFailure('too_large', { fields: [field] });
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data)
      throw new FeedbackPublicFailure('invalid', { fields: [`${field}.data`] });
    if (bytes.length === 0) throw new FeedbackPublicFailure('invalid', { fields: [`${field}.data`] });
    if (bytes.length > limits.maxAttachmentBytes)
      throw new FeedbackPublicFailure('too_large', { fields: [field] });
    return { index, bytes, sha256: sha256Of(bytes), declaredType: a.contentType };
  });
}

/** Header check (sniffed type and dimensions) without decoding pixels. */
export function inspectScreenshot(shot: OriginalScreenshot): {
  contentType: ScreenshotType;
  width: number;
  height: number;
} {
  const refuse = () =>
    new FeedbackPublicFailure('unsupported_attachment', { fields: [`attachments.${shot.index}`] });
  const sniffed = sniffBuffer(shot.bytes, 'screenshot');
  if (!sniffed.ok) throw refuse();
  const { contentType, width, height } = sniffed.value;
  if (contentType !== 'image/png' && contentType !== 'image/jpeg') throw refuse();
  // The widget sends the type the browser gave the file; bytes that disagree (a JPEG saved as .png) are refused.
  if (contentType !== shot.declaredType) throw refuse();
  if (!width || !height) throw refuse();
  if (width > FEEDBACK_IMAGE_MAX_SIDE || height > FEEDBACK_IMAGE_MAX_SIDE) throw refuse();
  if (width * height > FEEDBACK_IMAGE_MAX_PIXELS) throw refuse();
  return { contentType, width, height };
}

const EXTENSION: Record<ScreenshotType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

/**
 * The full pipeline over already decoded (base64) screenshots: header checks for all of them first (cheap, before
 * any decode), then decode + re-encode one by one in the image worker (FB-F02). Names are generated
 * (`screenshot-1.png`).
 */
export async function processScreenshots(
  shots: readonly OriginalScreenshot[],
  images: ImageRunner,
): Promise<ProcessedScreenshot[]> {
  const headers = shots.map((s) => inspectScreenshot(s));
  const out: ProcessedScreenshot[] = [];
  for (const [i, shot] of shots.entries()) {
    const header = headers[i] as (typeof headers)[number];
    let encoded: { bytes: Buffer; width: number; height: number };
    try {
      encoded = await images.run({ bytes: shot.bytes, ...header, maxPixels: FEEDBACK_IMAGE_MAX_PIXELS });
    } catch (err) {
      // The worker couldn't run at all: the server's fault, logged by the public error handler.
      if (err instanceof ImageJobError && err.kind === 'internal') throw err;
      throw new FeedbackPublicFailure('unsupported_attachment', { fields: [`attachments.${shot.index}`] });
    }
    out.push({
      index: shot.index,
      bytes: encoded.bytes,
      sha256: sha256Of(encoded.bytes),
      originalSha256: shot.sha256,
      contentType: header.contentType,
      width: encoded.width,
      height: encoded.height,
      name: `screenshot-${shot.index + 1}.${EXTENSION[header.contentType]}`,
    });
  }
  return out;
}
