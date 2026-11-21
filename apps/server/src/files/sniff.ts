/**
 * What an upload is, decided from its bytes (docs/decisions/bp-attachments.md BP-A03; BP-05): the client's
 * type is never trusted. Raster images (png, jpeg, gif, webp) must have a header we can read with a sane size
 * (a decompression-bomb cap); PDFs start with `%PDF-`; text is valid UTF-8 without NUL bytes and is labelled
 * from a small allowlist by extension; an `.svg` file that starts like an SVG document is labelled `image/svg+xml` so
 * clients can show it as an image (MPO-02), and an `.html`/`.htm`/`.xhtml` or Mermaid file its own type so clients can
 * preview it in their sandboxed frame (contracts CT-152, UI-R16) — all stay kind `text` and are served as `text/plain`
 * (`servedContentType`), so the origin never serves markup a browser renders. AVIF images, audio and video are kind
 * `file` with their media type when their bytes are the container their extension names (players, not downloads);
 * anything else is a plain file. Pure: fed chunk by chunk while the bytes are written.
 */
import { type AttachmentKind, contentTypeForName } from '@whombat/core';

/** Bytes kept from the start of the file for the magic numbers and image headers. */
export const SNIFF_HEAD_BYTES = 1024 * 1024;
/** Largest image side and area we accept (decompression bombs). */
export const IMAGE_MAX_SIDE = 20_000;
export const IMAGE_MAX_PIXELS = 60_000_000;

export interface Sniffed {
  contentType: string;
  kind: AttachmentKind;
  width: number | null;
  height: number | null;
}

export type SniffResult =
  | { ok: true; value: Sniffed }
  | { ok: false; reason: 'malformed_image' | 'image_too_large' };

const TEXT_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  yaml: 'text/yaml',
  yml: 'text/yaml',
};

/** The types a `text` file is served as (`servedContentType`); any other label is served as `text/plain`. */
export const SERVED_TEXT_TYPES: ReadonlySet<string> = new Set([...Object.values(TEXT_TYPES), 'text/plain']);

/**
 * Text a client previews by its type (contracts CT-152): an HTML page in the sandboxed frame, a Mermaid diagram. Kind
 * `text` all the same, served as `text/plain`.
 */
const PREVIEWED_TEXT_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/vnd.mermaid',
]);

/** The containers AVIF, audio and video come in, by the first bytes. */
function containerOf(head: Buffer): 'isobmff' | 'ogg' | 'ebml' | 'wave' | 'flac' | 'mpeg' | null {
  if (ascii(head, 4, 'ftyp')) return 'isobmff';
  if (ascii(head, 0, 'OggS')) return 'ogg';
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'ebml';
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE')) return 'wave';
  if (ascii(head, 0, 'fLaC')) return 'flac';
  // An ID3 tag, or an MPEG audio / ADTS frame sync.
  if (ascii(head, 0, 'ID3') || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)) return 'mpeg';
  return null;
}

const CONTAINERS: Record<string, readonly string[]> = {
  'image/avif': ['isobmff'],
  'audio/mp4': ['isobmff'],
  'video/mp4': ['isobmff'],
  'video/quicktime': ['isobmff'],
  'audio/ogg': ['ogg'],
  'audio/opus': ['ogg'],
  'video/ogg': ['ogg'],
  'audio/webm': ['ebml'],
  'video/webm': ['ebml'],
  'audio/wav': ['wave'],
  'audio/flac': ['flac'],
  'audio/mpeg': ['mpeg'],
  'audio/aac': ['mpeg'],
};

/**
 * AVIF, audio and video (UI-R16): the type the file's extension names (`contentTypeForName`), when the bytes are that
 * type's container (an AVIF also names its brand); null for anything else, which stays `application/octet-stream`.
 */
export function mediaTypeOf(head: Buffer, name: string): string | null {
  const named = contentTypeForName(name);
  const containers = named ? CONTAINERS[named] : undefined;
  if (!named || !containers) return null;
  const container = containerOf(head);
  if (!container || !containers.includes(container)) return null;
  if (named === 'image/avif' && !(ascii(head, 8, 'avif') || ascii(head, 8, 'avis'))) return null;
  return named;
}

/** An SVG document's start: an optional BOM, prolog, comments or DOCTYPE, then `<svg` (MPO-02). */
const SVG_START = /^\uFEFF?\s*(?:(?:<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*<svg[\s>/]/;

/** The text type for a name: a few known formats, else `text/plain`. */
export function textTypeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  return TEXT_TYPES[ext] ?? 'text/plain';
}

export class Sniffer {
  #head: Buffer[] = [];
  #headSize = 0;
  #decoder = new TextDecoder('utf-8', { fatal: true });
  #utf8 = true;
  #nul = false;
  #controls = 0;
  #size = 0;

  observe(chunk: Buffer): void {
    this.#size += chunk.length;
    if (this.#headSize < SNIFF_HEAD_BYTES) {
      const part = chunk.subarray(0, SNIFF_HEAD_BYTES - this.#headSize);
      this.#head.push(Buffer.from(part));
      this.#headSize += part.length;
    }
    if (!this.#nul && chunk.includes(0)) this.#nul = true;
    if (!this.#nul) this.#controls += countControls(chunk);
    if (this.#utf8 && !this.#nul) {
      try {
        this.#decoder.decode(chunk, { stream: true });
      } catch {
        this.#utf8 = false;
      }
    }
  }

  result(name: string): SniffResult {
    // Text has no NULs and next to no control characters (tabs, line breaks and ANSI escapes are fine).
    let utf8 = this.#utf8 && !this.#nul && this.#controls * 100 <= this.#size;
    if (utf8) {
      try {
        this.#decoder.decode();
      } catch {
        utf8 = false;
      }
    }
    return sniffBytes(Buffer.concat(this.#head), { name, utf8, size: this.#size });
  }
}

/** C0 control bytes that are not whitespace or ESC (binary data, not text). */
function countControls(chunk: Buffer): number {
  let n = 0;
  for (const b of chunk)
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x0b && b !== 0x1b) n++;
  return n;
}

/** Sniffs a whole buffer (artifacts, tests). */
export function sniffBuffer(bytes: Buffer, name: string): SniffResult {
  const sniffer = new Sniffer();
  sniffer.observe(bytes);
  return sniffer.result(name);
}

function startsWith(head: Buffer, bytes: readonly number[], at = 0): boolean {
  if (head.length < at + bytes.length) return false;
  return bytes.every((b, i) => head[at + i] === b);
}

function ascii(head: Buffer, at: number, text: string): boolean {
  return head.length >= at + text.length && head.toString('latin1', at, at + text.length) === text;
}

type Dims = { width: number; height: number } | null;

function pngSize(head: Buffer): Dims {
  // Signature, then the IHDR chunk: length 13, type, width, height (big-endian).
  if (head.length < 24 || head.readUInt32BE(8) !== 13 || !ascii(head, 12, 'IHDR')) return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

function gifSize(head: Buffer): Dims {
  if (head.length < 10) return null;
  return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(head: Buffer): Dims {
  let at = 2;
  while (at + 4 <= head.length) {
    if (head[at] !== 0xff) return null;
    let marker = head[at + 1] as number;
    // Fill bytes.
    while (marker === 0xff && at + 2 < head.length) {
      at++;
      marker = head[at + 1] as number;
    }
    // Fill bytes up to the end of what was read: no segment length to read.
    if (at + 4 > head.length) return null;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan before a frame header
    const length = head.readUInt16BE(at + 2);
    if (length < 2) return null;
    if (SOF.has(marker)) {
      if (at + 9 > head.length) return null;
      return { height: head.readUInt16BE(at + 5), width: head.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

function webpSize(head: Buffer): Dims {
  if (head.length < 30) return null;
  if (ascii(head, 12, 'VP8 ')) {
    // Key frame: start code 9d 01 2a, then 14-bit width and height.
    if (!startsWith(head, [0x9d, 0x01, 0x2a], 23)) return null;
    return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
  }
  if (ascii(head, 12, 'VP8L')) {
    if (head[20] !== 0x2f) return null;
    const bits = head.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (ascii(head, 12, 'VP8X')) {
    return { width: head.readUIntLE(24, 3) + 1, height: head.readUIntLE(27, 3) + 1 };
  }
  return null;
}

function image(contentType: string, dims: Dims): SniffResult {
  if (!dims || dims.width < 1 || dims.height < 1) return { ok: false, reason: 'malformed_image' };
  if (
    dims.width > IMAGE_MAX_SIDE ||
    dims.height > IMAGE_MAX_SIDE ||
    dims.width * dims.height > IMAGE_MAX_PIXELS
  )
    return { ok: false, reason: 'image_too_large' };
  return { ok: true, value: { contentType, kind: 'image', width: dims.width, height: dims.height } };
}

export function sniffBytes(head: Buffer, info: { name: string; utf8: boolean; size: number }): SniffResult {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return image('image/png', pngSize(head));
  if (startsWith(head, [0xff, 0xd8, 0xff])) return image('image/jpeg', jpegSize(head));
  if (ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a')) return image('image/gif', gifSize(head));
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return image('image/webp', webpSize(head));
  const file = (contentType: string, kind: AttachmentKind = 'file'): SniffResult => ({
    ok: true,
    value: { contentType, kind, width: null, height: null },
  });
  if (ascii(head, 0, '%PDF-')) return file('application/pdf', 'document');
  if (info.size > 0 && info.utf8) {
    const svg = /\.svg$/i.test(info.name) && SVG_START.test(head.toString('utf8', 0, 4096));
    if (svg) return file('image/svg+xml', 'text');
    const named = contentTypeForName(info.name);
    return file(named && PREVIEWED_TEXT_TYPES.has(named) ? named : textTypeFor(info.name), 'text');
  }
  const media = mediaTypeOf(head, info.name);
  if (media) return file(media);
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return file('application/zip');
  if (startsWith(head, [0x1f, 0x8b])) return file('application/gzip');
  return file('application/octet-stream');
}
