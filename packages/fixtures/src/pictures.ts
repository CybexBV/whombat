/**
 * Pictures for the service pages' fixtures (contracts 0.121.0, CT-1011): posters, camera snapshots and thumbnails drawn
 * here as small PNGs, so fixture mode can answer `things.image` (and the session's `thing-image` download) without
 * bundled files or anyone's artwork. Pure TypeScript (no Node or DOM APIs): the web, the phone and tests use it alike.
 *
 * A fixture's `ThingImage.ref` names what to draw: `fx-<shape>-<slug>.fixture` (`fx-poster-dune-part-two.fixture`,
 * `fx-wide-garage-offline.fixture`). The slug picks the colours, so every poster looks different and the same one
 * every time; a slug ending in `-offline` draws a dark grey snapshot. Real refs are the server's signed tokens; clients
 * never look inside either.
 */
import { THING_IMAGE_SHAPES, type ThingImage, type ThingImageShape } from '@whombat/core/domain';

/** The second part of every fixture ref. */
export const FIXTURE_PICTURE_SUFFIX = 'fixture';

const REF = /^fx-(poster|wide|square)-([a-z0-9-]{1,80})\.fixture$/;

/** Each shape's size in pixels: small, the clients scale them into their boxes. */
export const FIXTURE_PICTURE_SIZES: Record<ThingImageShape, { width: number; height: number }> = {
  poster: { width: 96, height: 144 },
  wide: { width: 192, height: 108 },
  square: { width: 96, height: 96 },
};

/** A fixture picture's ref for a shape and a slug (`dune-part-two`). */
export function fixturePictureRef(shape: ThingImageShape, slug: string): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `fx-${shape}-${clean || 'picture'}.${FIXTURE_PICTURE_SUFFIX}`;
}

/** A `ThingImage` of a fixture picture. */
export function fixtureImage(shape: ThingImageShape, slug: string, alt: string): ThingImage {
  return { ref: fixturePictureRef(shape, slug), alt, shape };
}

/** A drawn fixture picture: its type and bytes. */
export interface FixturePicture {
  contentType: 'image/png';
  bytes: Uint8Array;
}

/** The picture a fixture ref names, or null for any other ref (fixture mode answers 404, as the server does). */
export function fixturePicture(ref: string): FixturePicture | null {
  const m = REF.exec(ref);
  if (!m) return null;
  const shape = m[1] as ThingImageShape;
  if (!THING_IMAGE_SHAPES.includes(shape)) return null;
  const slug = m[2] as string;
  const { width, height } = FIXTURE_PICTURE_SIZES[shape];
  const rgb = draw(shape, slug, width, height);
  return { contentType: 'image/png', bytes: encodePng(width, height, rgb) };
}

/** `data:image/png;base64,…` of a fixture picture, for a client that loads pictures by URI; null for other refs. */
export function fixturePictureDataUrl(ref: string): string | null {
  const p = fixturePicture(ref);
  return p ? `data:${p.contentType};base64,${base64(p.bytes)}` : null;
}

/* Drawing ----------------------------------------------------------------------------------------- */

type Rgb = [number, number, number];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A colour from a hue (0…360), saturation and lightness (0…1). */
function hsl(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

function draw(shape: ThingImageShape, slug: string, width: number, height: number): Uint8Array {
  const h = hash(slug);
  const hue = h % 360;
  const offline = slug.endsWith('-offline');
  const out = new Uint8Array(width * height * 3);
  const put = (x: number, y: number, c: Rgb) => {
    const i = (y * width + x) * 3;
    out[i] = c[0];
    out[i + 1] = c[1];
    out[i + 2] = c[2];
  };
  if (offline) {
    // An offline camera: dark grey with a lighter cross.
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const onCross =
          Math.abs(x * height - y * width) < width * 1.5 ||
          Math.abs((width - x) * height - y * width) < width * 1.5;
        put(x, y, onCross ? [92, 92, 96] : [52, 52, 56]);
      }
    return out;
  }
  if (shape === 'wide') {
    // A camera's snapshot: sky, a horizon, ground, a building and the time bar in the corner.
    const sky = hsl((hue + 200) % 360, 0.45, 0.62);
    const skyLow = hsl((hue + 200) % 360, 0.35, 0.82);
    const ground = hsl((hue + 90) % 360, 0.35, 0.32);
    const groundLow = hsl((hue + 90) % 360, 0.3, 0.22);
    const wall = hsl((hue + 20) % 360, 0.25, 0.5);
    const horizon = Math.round(height * (0.5 + ((h >> 9) % 15) / 100));
    const bx = Math.round(width * (0.15 + ((h >> 13) % 40) / 100));
    const bw = Math.round(width * 0.28);
    const by = Math.round(horizon - height * 0.28);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let c =
          y < horizon
            ? mix(sky, skyLow, y / horizon)
            : mix(ground, groundLow, (y - horizon) / (height - horizon));
        if (x >= bx && x < bx + bw && y >= by && y < horizon) c = wall;
        if (x >= 4 && x < 52 && y >= 4 && y < 10) c = [236, 236, 236];
        put(x, y, c);
      }
    return out;
  }
  // A poster or a square: a gradient, a round shape and, on posters, a light band where a title would be.
  const top = hsl(hue, 0.55, 0.42);
  const bottom = hsl((hue + 40) % 360, 0.6, 0.16);
  const disc = hsl((hue + 180) % 360, 0.6, 0.7);
  const cx = width * (0.3 + ((h >> 11) % 40) / 100);
  const cy = height * (shape === 'poster' ? 0.38 : 0.45);
  const r = width * (0.18 + ((h >> 17) % 12) / 100);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let c = mix(top, bottom, (y + x * 0.3) / (height + width * 0.3));
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) c = mix(disc, c, 0.25);
      if (
        shape === 'poster' &&
        y > height * 0.78 &&
        y < height * 0.84 &&
        x > width * 0.12 &&
        x < width * 0.88
      )
        c = mix(c, [245, 245, 240], 0.85);
      put(x, y, c);
    }
  return out;
}

/* PNG (stored deflate: no compression, no dependencies) ------------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A 24-bit RGB PNG of `rgb` (rows top to bottom, 3 bytes a pixel). */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  // Raw scanlines, each with filter byte 0.
  const rowBytes = width * 3 + 1;
  const raw = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++)
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * rowBytes + 1);
  // zlib: header, stored blocks of at most 65 535 bytes, Adler-32.
  const blocks = Math.max(1, Math.ceil(raw.length / 65_535));
  const zlib = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const start = b * 65_535;
    const len = Math.min(65_535, raw.length - start);
    zlib[o++] = b === blocks - 1 ? 1 : 0;
    zlib[o++] = len & 0xff;
    zlib[o++] = len >>> 8;
    zlib[o++] = ~len & 0xff;
    zlib[o++] = (~len >>> 8) & 0xff;
    zlib.set(raw.subarray(start, start + len), o);
    o += len;
  }
  let a = 1;
  let s = 0;
  for (const byte of raw) {
    a = (a + byte) % 65_521;
    s = (s + a) % 65_521;
  }
  const adler = ((s << 16) | a) >>> 0;
  zlib[o++] = adler >>> 24;
  zlib[o++] = (adler >>> 16) & 0xff;
  zlib[o++] = (adler >>> 8) & 0xff;
  zlib[o++] = adler & 0xff;

  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const chunks: [string, Uint8Array][] = [
    ['IHDR', ihdr],
    ['IDAT', zlib],
    ['IEND', new Uint8Array(0)],
  ];
  const size = 8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0);
  const png = new Uint8Array(size);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const pv = new DataView(png.buffer);
  let p = 8;
  for (const [type, data] of chunks) {
    pv.setUint32(p, data.length);
    for (let i = 0; i < 4; i++) png[p + 4 + i] = type.charCodeAt(i);
    png.set(data, p + 8);
    pv.setUint32(p + 8 + data.length, crc32(png, p + 4, p + 8 + data.length));
    p += 12 + data.length;
  }
  return png;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += b === undefined ? '=' : B64[(n >> 6) & 63];
    out += c === undefined ? '=' : B64[n & 63];
  }
  return out;
}
