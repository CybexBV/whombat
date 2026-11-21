/**
 * Screenshot checks of drop mode (Whombat `docs/decisions/feedback-drop.md` FD-28 (4)): what the runtime would
 * refuse only after the visitor was told “received”, checked in the frame before anything is sealed. The same rules
 * as the runtime's header check (`inspectScreenshot`): PNG or JPEG by their bytes, the declared type must agree, and
 * the header's dimensions at most `FEEDBACK_IMAGE_MAX_SIDE` a side and `FEEDBACK_IMAGE_MAX_PIXELS` in all. Nothing
 * is decoded. Kept free of Zod, so the constants are repeated here and a test keeps them equal to `@whombat/core`.
 */
import type { AttachmentType } from './config';

/** `FEEDBACK_IMAGE_MAX_SIDE` of `@whombat/core/domain`. */
export const IMAGE_MAX_SIDE = 8192;
/** `FEEDBACK_IMAGE_MAX_PIXELS` of `@whombat/core/domain`. */
export const IMAGE_MAX_PIXELS = 16_000_000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** JPEG start-of-frame markers that carry the frame's dimensions (not DHT, JPG or DAC). */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export interface ImageHeader {
  type: AttachmentType;
  width: number;
  height: number;
}

const u16 = (b: Uint8Array, at: number) => ((b[at] as number) << 8) | (b[at + 1] as number);
const u32 = (b: Uint8Array, at: number) => u16(b, at) * 0x10000 + u16(b, at + 2);

function pngSize(b: Uint8Array): { width: number; height: number } | null {
  // Signature, then the IHDR chunk: length 13, type, width, height (big-endian).
  if (b.length < 24 || u32(b, 8) !== 13) return null;
  if (String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0) !== 'IHDR') return null;
  return { width: u32(b, 16), height: u32(b, 20) };
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    let marker = b[at + 1] as number;
    // Fill bytes.
    while (marker === 0xff && at + 2 < b.length) {
      at++;
      marker = b[at + 1] as number;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    // End of image, or a scan before any frame header.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16(b, at + 2);
    if (length < 2) return null;
    if (SOF.has(marker)) {
      if (at + 9 > b.length) return null;
      return { height: u16(b, at + 5), width: u16(b, at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

/** The image's type (by its bytes) and header dimensions, or null for anything but a PNG or JPEG we can read. */
export function imageHeader(bytes: Uint8Array): ImageHeader | null {
  if (PNG_SIGNATURE.every((v, i) => bytes[i] === v)) {
    const size = pngSize(bytes);
    return size ? { type: 'image/png', ...size } : null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegSize(bytes);
    return size ? { type: 'image/jpeg', ...size } : null;
  }
  return null;
}

/**
 * True when the runtime would take this screenshot: its bytes are the declared type, it isn't empty or over
 * `maxBytes`, and its header dimensions are within the limits.
 */
export function screenshotAcceptable(bytes: Uint8Array, declared: string, maxBytes: number): boolean {
  if (bytes.length === 0 || bytes.length > maxBytes) return false;
  const header = imageHeader(bytes);
  if (!header || header.type !== declared) return false;
  const { width, height } = header;
  if (width < 1 || height < 1) return false;
  if (width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) return false;
  return width * height <= IMAGE_MAX_PIXELS;
}

/** Canonical base64 (with padding) of `bytes`, what the runtime's strict decoder expects. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  return btoa(out);
}
