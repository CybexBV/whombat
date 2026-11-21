/**
 * Decoding and re-encoding a feedback screenshot (docs/decisions/feedback.md FB-08, FB-F02), and the worker thread
 * that does it off the server's event loop and heap (`image-pool.ts` starts it).
 *
 * This module is loaded two ways: imported by the server (the functions below, for tests), and as a worker's entry
 * (`new Worker(url, {workerData: {role: IMAGE_WORKER_ROLE}})`): from source by Node's own type stripping (or tsx), and
 * from a release as `app/image-worker.mjs`, its own esbuild entry (scripts/package). So it imports only Node
 * built-ins and plain JavaScript packages, never a workspace package or a relative module, and uses only erasable
 * TypeScript.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { inflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

/** `workerData.role` of the image worker: the module only listens for jobs in a worker started with it. */
export const IMAGE_WORKER_ROLE = 'whombat-feedback-images';

export type ScreenshotType = 'image/png' | 'image/jpeg';

export interface ImageHeader {
  contentType: ScreenshotType;
  width: number;
  height: number;
}

/** A job as posted to the worker. */
export interface ImageJobMessage extends ImageHeader {
  id: number;
  bytes: Uint8Array;
  /** `FEEDBACK_IMAGE_MAX_PIXELS` (the header check already refused anything larger). */
  maxPixels: number;
  /** An attachment preview (managed runtime, MR-14): scale down to fit this many pixels a side. */
  thumbnailMaxEdge?: number;
}

/** The worker's answers: `ready` once it listens, then one per job. */
export type ImageWorkerReply =
  | { ready: true }
  | { id: number; ok: true; bytes: Uint8Array; width: number; height: number }
  | { id: number; ok: false; error: string };

/**
 * What a JPEG decode may allocate (jpeg-js's own accounting, typed arrays outside the worker's V8 heap). A 16 MP
 * baseline JPEG with three full-resolution components needs about 340 MB, four components (CMYK) about 450 MB: 512
 * fits every JPEG the header check lets through (`FEEDBACK_IMAGE_MAX_PIXELS`) and nothing much larger.
 */
export const JPEG_MAX_MEMORY_MB = 512;
export const JPEG_QUALITY = 90;
/** Previews are for looking at, not keeping: a lower JPEG quality. */
export const PREVIEW_JPEG_QUALITY = 80;

/**
 * Scales RGBA pixels down to fit `maxEdge` a side (never up), averaging each output pixel's source box (area
 * filter, alpha-weighted so transparent pixels don't darken edges). Pure; runs in the worker.
 */
export function downscaleRgba(
  data: Uint8Array,
  width: number,
  height: number,
  maxEdge: number,
): { data: Uint8Array; width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  if (w === width && h === height) return { data, width, height };
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, i += 4) {
          const alpha = data[i + 3] as number;
          r += (data[i] as number) * alpha;
          g += (data[i + 1] as number) * alpha;
          b += (data[i + 2] as number) * alpha;
          a += alpha;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * A PNG up to the end of its IEND chunk: bytes appended after the image (a polyglot's payload) are dropped, not
 * decoded. Throws when the chunks don't walk to an IEND inside the buffer (truncated or malformed).
 */
export function pngThroughIend(bytes: Buffer): Buffer {
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const end = at + 12 + length;
    if (end > bytes.length) break;
    if (type === 'IEND') return bytes.subarray(0, end);
    at = end;
  }
  throw new Error('png without IEND');
}

const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * pngjs bounds the inflated size of a non-interlaced PNG by its dimensions, but inflates an interlaced one without a
 * limit: a small interlaced file could expand to gigabytes. Its image data is inflated here first with an output cap
 * (twice the non-interlaced size covers Adam7's extra filter bytes), so a bomb fails before pngjs sees it.
 */
export function checkInterlacedPng(png: Buffer): void {
  if (png.length < 33 || png[28] !== 1) return;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const depth = png[24] ?? 8;
  const channels = PNG_CHANNELS[png[25] ?? -1];
  if (!channels) throw new Error('png color type');
  const rowBytes = Math.ceil((width * channels * depth) / 8) + 1;
  const bound = 2 * rowBytes * height + 64 * 1024;
  const data: Buffer[] = [];
  let at = 8;
  while (at + 12 <= png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  inflateSync(Buffer.concat(data), { maxOutputLength: bound });
}

/** Decodes and re-encodes one image; throws on anything malformed. Synchronous CPU work: runs in the worker. */
export function reencode(
  bytes: Buffer,
  header: ImageHeader,
  maxPixels: number,
  thumbnailMaxEdge?: number,
): { bytes: Buffer; width: number; height: number } {
  if (header.contentType === 'image/png') {
    const whole = pngThroughIend(bytes);
    checkInterlacedPng(whole);
    const png = PNG.sync.read(whole, { checkCRC: true });
    if (png.width !== header.width || png.height !== header.height) throw new Error('png size mismatch');
    if (thumbnailMaxEdge) {
      const small = downscaleRgba(png.data, png.width, png.height, thumbnailMaxEdge);
      const target = new PNG({ width: small.width, height: small.height });
      target.data = Buffer.from(small.data.buffer, small.data.byteOffset, small.data.byteLength);
      const out = PNG.sync.write(target, {
        colorType: 6,
        inputColorType: 6,
        bitDepth: 8,
        inputHasAlpha: true,
      });
      return { bytes: out, width: small.width, height: small.height };
    }
    const out = PNG.sync.write(png, { colorType: 6, inputColorType: 6, bitDepth: 8, inputHasAlpha: true });
    return { bytes: out, width: png.width, height: png.height };
  }
  const raw = jpeg.decode(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: false,
    maxResolutionInMP: Math.ceil(maxPixels / 1_000_000),
    maxMemoryUsageInMB: JPEG_MAX_MEMORY_MB,
  });
  if (raw.width !== header.width || raw.height !== header.height) throw new Error('jpeg size mismatch');
  if (raw.data.length !== raw.width * raw.height * 4) throw new Error('jpeg data truncated');
  if (thumbnailMaxEdge) {
    const small = downscaleRgba(raw.data, raw.width, raw.height, thumbnailMaxEdge);
    const out = jpeg.encode(
      { width: small.width, height: small.height, data: small.data as never },
      PREVIEW_JPEG_QUALITY,
    );
    return { bytes: Buffer.from(out.data), width: small.width, height: small.height };
  }
  const out = jpeg.encode({ width: raw.width, height: raw.height, data: raw.data }, JPEG_QUALITY);
  return { bytes: Buffer.from(out.data), width: raw.width, height: raw.height };
}

function serve(port: NonNullable<typeof parentPort>): void {
  port.on('message', (job: ImageJobMessage) => {
    let reply: ImageWorkerReply;
    const transfer: ArrayBuffer[] = [];
    try {
      const input = Buffer.from(job.bytes.buffer, job.bytes.byteOffset, job.bytes.byteLength);
      const out = reencode(input, job, job.maxPixels, job.thumbnailMaxEdge);
      // A buffer of its own (never Node's shared pool), so it can be transferred rather than copied.
      const bytes = new Uint8Array(out.bytes);
      transfer.push(bytes.buffer);
      reply = { id: job.id, ok: true, bytes, width: out.width, height: out.height };
    } catch (err) {
      reply = { id: job.id, ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'failed' };
    }
    port.postMessage(reply, transfer);
  });
  port.postMessage({ ready: true } satisfies ImageWorkerReply);
}

if (!isMainThread && parentPort && (workerData as { role?: unknown } | null)?.role === IMAGE_WORKER_ROLE)
  serve(parentPort);
