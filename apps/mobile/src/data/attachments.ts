/**
 * Attachments on mobile (docs/decisions/bp-attachments.md BP-A13): what a picked photo or document becomes
 * for the upload, how a message's files are laid out and labelled, the authenticated source of an image,
 * and when the composer may send. Pure: no React Native imports, unit-tested.
 */
import { ApiError, anyUploading, showsSvgPreview, UploadError, type UploadItem } from '@whombat/client';
import {
  type Attachment,
  attachmentPreview,
  baseContentType,
  formatFileSize,
  isPageSet,
} from '@whombat/core';

/** A file chosen in the photo or document picker. */
export interface PickedFile {
  uri: string;
  name: string;
  type: string;
  size: number;
}

/**
 * Image picker asset → upload source. The picker's own metadata (location, EXIF) is never requested.
 * `index` is the asset's place in one pick, `now` when it was picked (both for `photoName`).
 */
export function fromImageAsset(
  asset: {
    uri: string;
    fileName?: string | null;
    mimeType?: string | null;
    fileSize?: number | null;
  },
  index = 0,
  now: Date = new Date(),
): PickedFile | null {
  if (!asset.fileSize) return null;
  const ext = asset.mimeType?.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg';
  return {
    uri: asset.uri,
    name: photoName(asset.fileName, ext, index, now),
    type: asset.mimeType ?? '',
    size: asset.fileSize,
  };
}

/**
 * A picked photo's name. Android's photo picker names files by their media id (“19.png”); those, and photos
 * without a name, get one from the moment they were picked in the device's time: “Photo 2026-09-24 21.04.png”,
 * then “Photo 2026-09-24 21.04 (2).png” for the next photo of the same pick. Real names are kept.
 */
export function photoName(
  fileName: string | null | undefined,
  ext: string,
  index: number,
  now: Date,
): string {
  const name = fileName?.trim() ?? '';
  const stem = name.replace(/\.[^.]*$/, '');
  if (stem && !/^[\d_-]+$/.test(stem)) return name;
  const two = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? ext;
  return `Photo ${day} ${two(now.getHours())}.${two(now.getMinutes())}${index > 0 ? ` (${index + 1})` : ''}.${extension}`;
}

/**
 * Photos go up at most this long on their longest side (AP-908), as JPEG at `PHOTO_JPEG_QUALITY`: a phone's 12–50 MP
 * camera photo is 3–15 MB, and a conversation shows it at most a screen wide (the full-screen viewer zooms a 2048px
 * picture fine). The Whombat makes its own 720px thumbnail either way (CT-298).
 */
export const PHOTO_MAX_EDGE = 2048;
export const PHOTO_JPEG_QUALITY = 0.8;

/**
 * Whether a picked image goes up scaled down (AP-908): a photo (JPEG, HEIC/HEIF) longer than `PHOTO_MAX_EDGE`. A PNG
 * (a screenshot or diagram: its text stays sharp), a GIF (it may move), WebP and any smaller image go as they are.
 */
export function scalesDown(asset: {
  width?: number | null;
  height?: number | null;
  mimeType?: string | null;
}): boolean {
  if (!/^image\/(jpe?g|heic|heif)$/i.test(asset.mimeType ?? '')) return false;
  return Math.max(asset.width ?? 0, asset.height ?? 0) > PHOTO_MAX_EDGE;
}

/** The resize for a decoded (upright) image: its longest side to `PHOTO_MAX_EDGE`, the other in proportion. */
export function photoResize(width: number, height: number): { width: number } | { height: number } {
  return width >= height ? { width: PHOTO_MAX_EDGE } : { height: PHOTO_MAX_EDGE };
}

/** The picked photo as its scaled JPEG (`….jpg`, `image/jpeg`); as picked when that didn't come out smaller. */
export function scaledPhoto(file: PickedFile, scaled: { uri: string; size: number }): PickedFile {
  if (!(scaled.size > 0) || scaled.size >= file.size) return file;
  return {
    uri: scaled.uri,
    name: `${file.name.replace(/\.[A-Za-z0-9]+$/, '')}.jpg`,
    type: 'image/jpeg',
    size: scaled.size,
  };
}

/**
 * Each item through `work`, one after the other, the results in the items' order. A pick's photos are prepared this
 * way: each holds its decoded original (about 190 MB for a 48-megapixel photo) until it is saved, and ten of them at
 * once get the app closed for memory.
 */
export async function oneAtATime<T, R>(
  items: readonly T[],
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (const [index, item] of items.entries()) results.push(await work(item, index));
  return results;
}

/** Document picker asset → upload source. */
export function fromDocumentAsset(asset: {
  uri: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
}): PickedFile | null {
  if (!asset.size) return null;
  return { uri: asset.uri, name: asset.name || 'file', type: asset.mimeType ?? '', size: asset.size };
}

/** Send is on with text, or with ready files and nothing still uploading. */
export function canSend(text: string, items: readonly UploadItem[]): boolean {
  if (anyUploading(items)) return false;
  return text.trim().length > 0 || items.some((i) => i.state === 'ready');
}

/** An image scaled to fit `maxWidth` × `maxHeight`, keeping its shape. */
export function imageBox(
  a: Pick<Attachment, 'width' | 'height'>,
  maxWidth: number,
  maxHeight = 220,
): { width: number; height: number } {
  const w = a.width ?? maxWidth;
  const h = a.height ?? maxHeight;
  const scale = Math.min(1, maxWidth / w, maxHeight / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * How a message's file is drawn (AP-328, CT-152): a page set as its own card (whatever its name says: older apps see a
 * ZIP), a picture this phone draws (`avif`: AVIF too), an SVG while it can be drawn (`svg`), an HTML page or a Mermaid
 * file as its preview card, else a row.
 */
export type FileTile = 'pages' | 'image' | 'svg' | 'html' | 'mermaid' | 'row';

export function fileTile(
  a: Pick<Attachment, 'name' | 'contentType' | 'kind' | 'size'>,
  can: { avif: boolean; svg: boolean },
): FileTile {
  if (isPageSet(a)) return 'pages';
  const preview = attachmentPreview(a);
  if (preview === 'image')
    return baseContentType(a.contentType) !== 'image/avif' || can.avif ? 'image' : 'row';
  if (preview === 'svg') return can.svg && showsSvgPreview(a) ? 'svg' : 'row';
  if (preview === 'html' || preview === 'mermaid') return preview;
  return 'row';
}

/** “PDF · 2.4 MB”, “Text · 812 KB”, “File · 3 MB”. */
export function attachmentMeta(a: Pick<Attachment, 'kind' | 'size'>): string {
  const label = { image: 'Image', text: 'Text', document: 'PDF', file: 'File' }[a.kind];
  return `${label} · ${formatFileSize(a.size)}`;
}

/**
 * What a conversation's image tile shows (contracts 0.55, CT-298; MX-09): the thumbnail the Whombat made (longest side
 * 720px) when it made one, else the file itself. The full-screen viewer always shows the file.
 */
export function tilePicture(a: Pick<Attachment, 'url' | 'thumbnailUrl'>): { path: string; preview: boolean } {
  return a.thumbnailUrl ? { path: a.thumbnailUrl, preview: true } : { path: a.url, preview: false };
}

/**
 * The name a downloaded file keeps when it is shared or opened: its original name, made safe as a file name
 * (no directories). Every attachment has its own cache file in its scope, so names never collide.
 */
export function localFileName(a: Pick<Attachment, 'name'>): string {
  return a.name.replace(/[/\\]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
}

/**
 * Whether trying the same upload again can work. Not for answers about the file or the place (too big, the
 * burrow's storage full, a damaged or unshowable image, a conversation one cannot post in): those chips offer
 * Remove only. Yes for the connection, the server's own trouble, a busy hour (rate limit) or a clash.
 */
export function uploadRetryable(error: unknown): boolean {
  const status = error instanceof UploadError || error instanceof ApiError ? error.status : null;
  // No answer at all: the connection (or the file could not be read this time).
  if (status === null) return true;
  return status >= 500 || status === 408 || status === 409 || status === 429;
}
