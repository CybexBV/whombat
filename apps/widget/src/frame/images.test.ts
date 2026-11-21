import { describe, expect, it } from 'vitest';
import { bytesToBase64, IMAGE_MAX_PIXELS, imageHeader, screenshotAcceptable } from './images';

function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

/** SOI, an APP0 segment to skip, fill bytes, then a baseline or progressive frame header. */
function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    4,
    0x4a,
    0x46,
    0xff,
    0xff,
    sof,
    0,
    17,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    3,
  ]);
}

describe('imageHeader', () => {
  it('reads PNG IHDR and JPEG SOF dimensions', () => {
    expect(imageHeader(png(1440, 900))).toEqual({ type: 'image/png', width: 1440, height: 900 });
    expect(imageHeader(jpeg(800, 600))).toEqual({ type: 'image/jpeg', width: 800, height: 600 });
    expect(imageHeader(jpeg(800, 600, 0xc2))).toEqual({ type: 'image/jpeg', width: 800, height: 600 });
  });

  it('refuses anything else', () => {
    const gif = new TextEncoder().encode('GIF89a\x01\x00\x01\x00');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const noFrame = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]);
    const badIhdr = png(1, 1);
    badIhdr[12] = 0x78;
    for (const bytes of [gif, svg, noFrame, badIhdr, png(1, 1).subarray(0, 20), new Uint8Array(0)])
      expect(imageHeader(bytes)).toBeNull();
  });
});

describe('screenshotAcceptable', () => {
  it('takes what the runtime takes', () => {
    expect(screenshotAcceptable(png(8192, 1953), 'image/png', 1024)).toBe(true);
    expect(screenshotAcceptable(jpeg(4000, 4000), 'image/jpeg', 1024)).toBe(true);
  });

  it('refuses a type that disagrees, empty or oversized bytes, and oversized or empty dimensions', () => {
    expect(screenshotAcceptable(jpeg(10, 10), 'image/png', 1024)).toBe(false);
    expect(screenshotAcceptable(png(10, 10), 'image/jpeg', 1024)).toBe(false);
    expect(screenshotAcceptable(new Uint8Array(0), 'image/png', 1024)).toBe(false);
    expect(screenshotAcceptable(png(10, 10), 'image/png', 32)).toBe(false);
    expect(screenshotAcceptable(png(8193, 10), 'image/png', 1024)).toBe(false);
    expect(screenshotAcceptable(png(10, 8193), 'image/png', 1024)).toBe(false);
    expect(screenshotAcceptable(png(8000, 2001), 'image/png', 1024)).toBe(8000 * 2001 <= IMAGE_MAX_PIXELS);
    expect(screenshotAcceptable(png(0, 10), 'image/png', 1024)).toBe(false);
    expect(screenshotAcceptable(jpeg(10, 0), 'image/jpeg', 1024)).toBe(false);
  });
});

describe('bytesToBase64', () => {
  it('is canonical base64, also across chunks', () => {
    const big = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
    expect(bytesToBase64(big)).toBe(Buffer.from(big).toString('base64'));
    expect(bytesToBase64(new Uint8Array([1, 2]))).toBe('AQI=');
  });
});
