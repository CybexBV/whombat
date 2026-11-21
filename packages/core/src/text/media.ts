/**
 * How a client shows an attachment (CT-152): as an image, an SVG image, an HTML page preview, a PDF, an audio or video
 * player, text, or only as a download chip. Decided from the stored (sniffed) `contentType`, the `kind` and, for types a
 * sniffer reports as plain text, the file name's extension. `AttachmentKind` stays the closed set it was
 * (`image | text | document | file`): an HTML page is a `text` attachment with `text/html`, audio and video are `file`
 * attachments with their media type; old clients keep parsing new messages. Pure.
 */

import type { AttachmentKind } from '../domain/message.js';

/** Image types shown inline through `<img>` (raster; SVG is {@link AttachmentPreview} `svg`). */
export const PREVIEW_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
] as const;

/** Audio types clients offer a native player for. */
export const PREVIEW_AUDIO_TYPES = [
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/webm',
  'audio/flac',
] as const;

/** Video types clients offer a native player for. */
export const PREVIEW_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'] as const;

/** Media types by file extension (lowercase, without the dot), for the types previews depend on. */
export const MEDIA_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  weba: 'audio/webm',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mmd: 'text/vnd.mermaid',
  mermaid: 'text/vnd.mermaid',
};

/** The media type a file name's extension stands for (`logo.html` → `text/html`), or null. */
export function contentTypeForName(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  return MEDIA_TYPES_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** A media type without parameters, lowercase: `Text/HTML; charset=utf-8` → `text/html`. */
export function baseContentType(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

export type AttachmentPreview = 'image' | 'svg' | 'html' | 'mermaid' | 'pdf' | 'audio' | 'video' | 'text';

const has = (list: readonly string[], type: string) => list.includes(type);
const UNKNOWN = (type: string) => type === '' || type === 'application/octet-stream';
/** A type a sniffer gives files it can't tell apart; then the extension decides. */
const TEXTUAL = (type: string) =>
  UNKNOWN(type) || type === 'text/plain' || type === 'text/xml' || type === 'application/xml';

/**
 * How to show an attachment, or null for a download chip only:
 * - `image`: a raster image ({@link PREVIEW_IMAGE_TYPES}, or `kind: image`);
 * - `svg`: `image/svg+xml`, or an `.svg` file sniffed as text; shown through `<img>` like any image;
 * - `html`: `text/html` / `application/xhtml+xml`, or an `.html`/`.htm`/`.xhtml` file sniffed as text; the preview card
 *   in a sandboxed frame (`html.ts`);
 * - `mermaid`: an `.mmd`/`.mermaid` text file, a diagram;
 * - `pdf`: `application/pdf` (or `kind: document`);
 * - `audio` / `video`: {@link PREVIEW_AUDIO_TYPES} / {@link PREVIEW_VIDEO_TYPES} (or an extension that says so on a
 *   file sniffed as `application/octet-stream`);
 * - `text`: any other `kind: text`.
 */
export function attachmentPreview(a: {
  name: string;
  contentType: string;
  kind?: AttachmentKind;
}): AttachmentPreview | null {
  const type = baseContentType(a.contentType);
  const byName = contentTypeForName(a.name);
  const guess = TEXTUAL(type) && byName ? byName : type;
  if (type === 'image/svg+xml' || guess === 'image/svg+xml') return 'svg';
  if (a.kind === 'image' || has(PREVIEW_IMAGE_TYPES, type)) return 'image';
  if (UNKNOWN(type) && byName && has(PREVIEW_IMAGE_TYPES, byName)) return 'image';
  if (guess === 'text/html' || guess === 'application/xhtml+xml') return 'html';
  if (guess === 'text/vnd.mermaid') return 'mermaid';
  if (type === 'application/pdf' || a.kind === 'document') return 'pdf';
  if (has(PREVIEW_AUDIO_TYPES, guess)) return 'audio';
  if (has(PREVIEW_VIDEO_TYPES, guess)) return 'video';
  if (a.kind === 'text') return 'text';
  return null;
}
