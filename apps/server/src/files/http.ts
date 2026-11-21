/**
 * Response headers for attachment bytes (BP-05, docs/decisions/bp-attachments.md BP-A05): uploaded content
 * never runs in the app's origin. Pure helpers, unit-tested.
 */
import type { AttachmentKind } from '@whombat/core';
import { SERVED_TEXT_TYPES } from './sniff';

/** A single inclusive byte range, or why the header cannot be served. */
export type RangeResult =
  | { kind: 'none' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * `Range: bytes=a-b` (one range only; `a-`, `-n` supported). Several ranges, other units or garbage are
 * ignored (the whole file is sent, as RFC 9110 allows); a range past the end is unsatisfiable.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'none' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { kind: 'none' };
  const [, a, b] = m as unknown as [string, string, string];
  if (a === '' && b === '') return { kind: 'none' };
  if (size === 0) return { kind: 'unsatisfiable' };
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (start >= size || end < start) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end };
}

/** `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf` (ASCII fallback without quotes). */
export function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Images we sniffed may show inline; everything else downloads. */
export function dispositionFor(kind: AttachmentKind, forceDownload: boolean): 'inline' | 'attachment' {
  return kind === 'image' && !forceDownload ? 'inline' : 'attachment';
}

/**
 * The type we send: the sniffed one, with a charset for text. A text file labelled with anything but a plain text
 * type (an SVG's `image/svg+xml`, MPO-02) is sent as `text/plain`: the origin never serves markup a browser renders.
 */
export function servedContentType(contentType: string, kind: AttachmentKind): string {
  if (kind !== 'text') return contentType;
  return `${SERVED_TEXT_TYPES.has(contentType) ? contentType : 'text/plain'}; charset=utf-8`;
}

/** Headers every attachment response carries, whatever it is. */
export function attachmentHeaders(input: {
  contentType: string;
  kind: AttachmentKind;
  name: string;
  sha256: string;
  forceDownload: boolean;
}): Record<string, string> {
  return {
    'content-type': servedContentType(input.contentType, input.kind),
    'content-disposition': contentDisposition(dispositionFor(input.kind, input.forceDownload), input.name),
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'private, max-age=3600',
    etag: `"${input.sha256}"`,
    'accept-ranges': 'bytes',
    'x-whombat-sha256': input.sha256,
  };
}

/** Whether `If-None-Match` already names this sha256. */
export function notModified(ifNoneMatch: string | undefined, sha256: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === `"${sha256}"`);
}
