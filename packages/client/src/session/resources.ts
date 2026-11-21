/**
 * Resources through the session (AP-12): server-hosted bytes (attachments, exports) are fetched as session
 * streams and handed to the platform — `blob:` object URLs on the web (`@whombat/client/web`), cache files on
 * mobile — instead of the platform loading a server URL with ambient credentials. On the legacy HTTP transport
 * the same code streams over `fetch`.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ApplianceSession, ResourceMeta, ResourceRef, ResourceStream } from './types';
import { StreamError } from './types';

const ATTACHMENT_PATH = /^\/api\/v1\/burrows\/([^/?#]+)\/attachments\/([^/?#]+)(?:\?(.*))?$/;

/**
 * The resource an `Attachment.url` (a relative API path, `@whombat/core` `Attachment`) names, or null for
 * anything else. Only known paths map: the appliance serves an allowlist, not URLs.
 */
export function resourceFromUrl(url: string, options: { download?: boolean } = {}): ResourceRef | null {
  const m = ATTACHMENT_PATH.exec(url);
  if (!m?.[1] || !m[2]) return null;
  // A stray `%` in the path is no attachment (`decodeURIComponent` throws on it, here while a message is drawn).
  let burrow: string;
  let attachmentId: string;
  try {
    burrow = decodeURIComponent(m[1]);
    attachmentId = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  const query = new URLSearchParams(m[3] ?? '');
  const download = options.download ?? query.get('download') === '1';
  return { kind: 'attachment', burrow, attachmentId, ...(download && { download: true }) };
}

/**
 * A picture on a thing's page as a resource (contracts 0.121, CT-1000; app service-dashboards.md AP-4537): loaded like
 * an attachment image — HTTP `things.image`, or the session's `thing-image` download stream.
 */
export function thingImageResource(
  burrow: string,
  thing: string,
  ref: string,
): Extract<ResourceRef, { kind: 'thing-image' }> {
  return { kind: 'thing-image', burrow, thing, ref };
}

/** Stable cache key of a resource (the download flag doesn't change the bytes). */
export function resourceKey(ref: ResourceRef): string {
  // A preview (an image's thumbnail, contracts 0.55 CT-298) is other bytes than the file: its own key.
  if (ref.kind === 'attachment')
    return `att:${ref.burrow}:${ref.attachmentId}${ref.variant === 'preview' ? ':preview' : ''}`;
  if (ref.kind === 'backup-file') return `bkf:${ref.burrow}:${ref.backupFileId}`;
  // A ref is up to 600 characters: its hash keeps the key short enough for a file name (the phone's cache).
  if (ref.kind === 'thing-image')
    return `img:${bytesToHex(sha256(new TextEncoder().encode(`${ref.burrow}\n${ref.thing}\n${ref.ref}`))).slice(0, 40)}`;
  return `exp:${ref.op}:${JSON.stringify(ref.input)}`;
}

export interface ReadResult {
  meta: ResourceMeta;
  bytes: Uint8Array;
  /** More bytes existed beyond `maxBytes` (the stream was cancelled there). */
  truncated: boolean;
}

/** Reads a resource into memory, up to `maxBytes` (previews, images): never unbounded. */
export async function readResource(
  session: ApplianceSession,
  ref: ResourceRef,
  options: { maxBytes: number; range?: { start: number; end?: number }; signal?: AbortSignal },
): Promise<ReadResult> {
  const stream = await session.openResource(ref, {
    ...(options.range && { range: options.range }),
    ...(options.signal && { signal: options.signal }),
  });
  if (stream.meta.size !== null && stream.meta.size > options.maxBytes && !options.range) {
    stream.cancel();
    throw new StreamError('too_large', 'This file is too large to open here.');
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stream.chunks) {
    const room = options.maxBytes - total;
    if (chunk.byteLength >= room) {
      parts.push(chunk.subarray(0, room));
      total += room;
      truncated = chunk.byteLength > room;
      if (truncated || total >= options.maxBytes) {
        stream.cancel();
        break;
      }
      continue;
    }
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  return { meta: stream.meta, bytes, truncated };
}

/**
 * A file an export op produced (AP-45; a pack archive): the stream's raw bytes, never a JSON body rebuilt around them.
 * `sha256` is the appliance's `stream_done.sha256`, and the bytes hash to it.
 */
export interface ExportFile {
  kind: 'file';
  /** The name the appliance gave it (`meta.name`), when it gave one. */
  name: string | null;
  contentType: string;
  bytes: Uint8Array;
  sha256: string;
}

export function isExportFile(value: unknown): value is ExportFile {
  const v = value as Partial<ExportFile> | null;
  return typeof v === 'object' && v !== null && v.kind === 'file' && v.bytes instanceof Uint8Array;
}

/**
 * Reads an export stream whole, at most `maxBytes`, as an `ExportFile`. The appliance must have sent `stream_done`
 * and the bytes must be what it announced (`meta.size`, `stream_done.size` and `sha256`), else `StreamError`
 * `integrity`: a damaged or unverified file is never handed over. The stream itself hashed the bytes as they came and
 * failed with `integrity` when they didn't match (`ResourceStream.summary`), so they aren't hashed a second time here.
 */
export async function readExportFile(stream: ResourceStream, maxBytes: number): Promise<ExportFile> {
  if (stream.meta.size !== null && stream.meta.size > maxBytes) {
    stream.cancel();
    throw new StreamError('too_large', 'This file is too large to open here.');
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream.chunks) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      stream.cancel();
      throw new StreamError('too_large', 'This file is too large to open here.');
    }
    parts.push(chunk);
  }
  const bytes = concat(parts, total);
  const done = stream.summary();
  if (!done || done.size !== total || (stream.meta.size !== null && stream.meta.size !== total))
    throw new StreamError('integrity', 'The file wasn’t what your Whombat sent.');
  return {
    kind: 'file',
    name: stream.meta.name,
    contentType: stream.meta.contentType,
    bytes,
    sha256: done.sha256,
  };
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  return bytes;
}

/**
 * How a resource may be shown (AP-16). Uploaded content is never rendered as a same-origin document: raster
 * images go into `<img>` (never SVG: it can carry script), text is shown as text, everything else (HTML, SVG,
 * PDF, archives) is a download only.
 */
export type PreviewKind = 'image' | 'text' | 'download';

const RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
const TEXTUAL = /^(text\/plain|text\/markdown|text\/csv|application\/json|text\/x-log)(;|$)/i;

export function previewKind(contentType: string): PreviewKind {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (RASTER.has(type)) return 'image';
  if (TEXTUAL.test(contentType.trim())) return 'text';
  return 'download';
}
