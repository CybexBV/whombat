/**
 * What changed on a screen, from the builder's before and after screenshots (docs/decisions/council.md): the
 * changed areas are found from the pixels, never guessed, and drawn as one picture, before on top and after below,
 * each area outlined and numbered on both halves so a subtle change is seen at a glance. Pure: bytes in, bytes out.
 */
import { COUNCIL_AREAS_MAX } from '@whombat/core';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { checkInterlacedPng, JPEG_MAX_MEMORY_MB, pngThroughIend } from '../feedback/image-worker';
import { SNIFF_HEAD_BYTES, sniffBytes } from '../files/sniff';

export type ShotType = 'image/png' | 'image/jpeg';

/** A decoded screenshot: `data` is RGBA, four bytes a pixel, row by row. */
export interface Shot {
  width: number;
  height: number;
  data: Uint8Array;
}

/** One changed area, numbered 1…n top to bottom then left to right, in the after image's pixels. */
export interface Area {
  n: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Screenshots are a screen or a long page; anything larger is not a screenshot and costs too much to compare. */
export const SHOT_MAX_SIDE = 6000;
export const SHOT_MAX_PIXELS = 24_000_000;

export type ShotRefusal = 'malformed' | 'too_large';

/** An upload that can't be compared; the message is plain words the builder can act on. */
export class ShotError extends Error {
  constructor(
    readonly reason: ShotRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'ShotError';
  }
}

const TYPE_NAMES: Record<ShotType, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG' };

function tooLarge(width?: number, height?: number): ShotError {
  const size = width && height ? `${width} × ${height} pixels, ` : '';
  return new ShotError(
    'too_large',
    `The screenshot is too large (${size}at most ${SHOT_MAX_SIDE} pixels a side and ${SHOT_MAX_PIXELS / 1_000_000} megapixels).`,
  );
}

/**
 * Decodes a PNG or JPEG screenshot to RGBA. The size is read from the header and checked before anything is
 * decoded, so a small file that claims a huge image is refused without allocating it.
 */
export function decodeShot(bytes: Buffer, type: ShotType): Shot {
  const malformed = () => new ShotError('malformed', `That isn’t a valid ${TYPE_NAMES[type]} image.`);
  const sniffed = sniffBytes(bytes.subarray(0, SNIFF_HEAD_BYTES), {
    name: type === 'image/png' ? 'shot.png' : 'shot.jpg',
    utf8: false,
    size: bytes.length,
  });
  if (!sniffed.ok) throw sniffed.reason === 'image_too_large' ? tooLarge() : malformed();
  const { contentType, width, height } = sniffed.value;
  if (contentType !== type || !width || !height) throw malformed();
  if (width > SHOT_MAX_SIDE || height > SHOT_MAX_SIDE || width * height > SHOT_MAX_PIXELS)
    throw tooLarge(width, height);
  let decoded: { width: number; height: number; data: Uint8Array };
  try {
    if (type === 'image/png') {
      const whole = pngThroughIend(bytes);
      checkInterlacedPng(whole);
      decoded = PNG.sync.read(whole, { checkCRC: true });
    } else {
      decoded = jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: false,
        maxResolutionInMP: SHOT_MAX_PIXELS / 1_000_000,
        maxMemoryUsageInMB: JPEG_MAX_MEMORY_MB,
      });
    }
  } catch {
    throw malformed();
  }
  if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4)
    throw malformed();
  return { width, height, data: decoded.data };
}

/* Finding what changed ------------------------------------------------------------------------------------------- */

/*
 * How different two pixels must be, as a YIQ colour distance (pixelmatch's, which weighs brightness the way eyes do)
 * relative to the largest possible one. Two kinds of pair need different limits, and the pair itself tells which it
 * is: lossless screenshots of the same page are identical wherever nothing changed, while a JPEG on either side
 * leaves a faint difference (a few levels) on nearly every pixel and up to 0.22 next to sharp text at quality 75.
 * Real changes leave almost no faint differences, so a pair whose differences are mostly faint is lossy.
 */
const MAX_YIQ_DELTA = 35215;
const squared = (fraction: number) => MAX_YIQ_DELTA * fraction * fraction;
/** At most this is faint: four levels of brightness or so, what a JPEG round trip leaves everywhere. */
const FAINT_DELTA = squared(0.015);
/** A lossy pair: only a pixel no JPEG of quality 70 and up moves this far counts on its own… */
const STRONG_DELTA = squared(0.25);
/** …or a cell whose average colour moved this far: JPEG keeps each 8×8 block's average, so a shade change shows. */
const SHIFT_DELTA = squared(0.035);
/** A pair is lossy when faint differences cover this share of it and outnumber the clear ones two to one. */
const LOSSY_FAINT_SHARE = 0.005;
const LOSSY_FAINT_RATIO = 2;
/** Changed pixels are grouped on a grid of 8 px cells: coarse enough to be fast, fine enough for a small icon. */
const CELL_SHIFT = 3;
/** Changed cells this many cells apart still form one area, so the letters of a changed label make one box. */
const LINK_CELLS = 2;
/** Areas closer than this (px) are one area: a button and its label, two lines of one paragraph. */
const MERGE_GAP = 16;
/** Areas that line up (one spans most of the other's width or height) join from this many times as far: the top and
 * bottom edges of a button that grew both ways are one change. */
const ALIGNED_REACH = 3;
const ALIGNED_SHARE = 0.8;
/** Fewer changed pixels than this in an area are noise (a cursor blink, a stray dot), not a change worth a number. */
const AREA_MIN_PIXELS = 6;
/** Areas whose tops are this close (px) read as one row and are numbered left to right. */
const ROW_TOLERANCE = 32;
/** When the after image is smaller, a band this tall (px) along its edge marks where the rest went. */
const EDGE_BAND = 16;
/** More areas than this are merged in growing steps before the closest pairs are joined one by one. */
const PAIRWISE_MAX = 48;

interface Box {
  x0: number;
  y0: number;
  /** Exclusive. */
  x1: number;
  y1: number;
}

/** Per grid cell: how many pixels changed and the bounds they span. */
class Cells {
  readonly count: Int32Array;
  readonly minX: Int32Array;
  readonly minY: Int32Array;
  readonly maxX: Int32Array;
  readonly maxY: Int32Array;

  constructor(cells: number) {
    this.count = new Int32Array(cells);
    this.minX = new Int32Array(cells);
    this.minY = new Int32Array(cells);
    this.maxX = new Int32Array(cells);
    this.maxY = new Int32Array(cells);
  }

  /** Pixels arrive row by row, so the first one of a cell is its top. */
  add(c: number, x: number, y: number): void {
    if (this.count[c] === 0) this.set(c, x, y, x, y);
    else {
      if (x < (this.minX[c] as number)) this.minX[c] = x;
      if (x > (this.maxX[c] as number)) this.maxX[c] = x;
      this.maxY[c] = y;
    }
    this.count[c] = (this.count[c] as number) + 1;
  }

  set(c: number, x0: number, y0: number, x1: number, y1: number): void {
    this.minX[c] = x0;
    this.minY[c] = y0;
    this.maxX[c] = x1;
    this.maxY[c] = y1;
  }

  copy(c: number, from: Cells): void {
    this.set(
      c,
      from.minX[c] as number,
      from.minY[c] as number,
      from.maxX[c] as number,
      from.maxY[c] as number,
    );
  }
}

/** The YIQ distance (squared) of a colour difference. */
function yiq(dr: number, dg: number, db: number): number {
  const y = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
  const i = dr * 0.59597799 - dg * 0.2741761 - db * 0.32180189;
  const q = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;
  return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
}

/** A channel as seen over white, as a transparent page is. */
function overWhite(c: number, alpha: number): number {
  return alpha === 255 ? c : 255 + (c - 255) * (alpha / 255);
}

/** A 32-bit view of RGBA bytes, so equal pixels (most of a screenshot) are skipped with one comparison. */
function words(data: Uint8Array): Uint32Array | null {
  return data.byteOffset % 4 === 0 ? new Uint32Array(data.buffer, data.byteOffset, data.length >> 2) : null;
}

/** How much two spans overlap, as a share of the shorter one. */
function sharedShare(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / Math.max(1, Math.min(a1 - a0, b1 - b0));
}

/** Whether two boxes are one change: no further apart than `gap` either way, or lined up and a little further. */
function belongTogether(a: Box, b: Box, gap: number): boolean {
  const dx = Math.max(0, b.x0 - a.x1, a.x0 - b.x1);
  const dy = Math.max(0, b.y0 - a.y1, a.y0 - b.y1);
  if (dx <= gap && dy <= gap) return true;
  const reach = gap * ALIGNED_REACH;
  if (dx === 0 && dy <= reach) return sharedShare(a.x0, a.x1, b.x0, b.x1) >= ALIGNED_SHARE;
  if (dy === 0 && dx <= reach) return sharedShare(a.y0, a.y1, b.y0, b.y1) >= ALIGNED_SHARE;
  return false;
}

function union(a: Box, b: Box): Box {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/** Joins every two boxes that belong together at `gap`, until none do. */
function mergeNear(boxes: Box[], gap: number): Box[] {
  const out = boxes.slice();
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = out.length - 1; j > i; j--) {
        if (!belongTogether(out[i] as Box, out[j] as Box, gap)) continue;
        out[i] = union(out[i] as Box, out[j] as Box);
        out.splice(j, 1);
        merged = true;
      }
    }
  }
  return out;
}

/** Joins the two closest boxes (the smaller union first when equally close) until at most `max` remain. */
function mergeClosest(boxes: Box[], max: number): Box[] {
  const out = boxes.slice();
  while (out.length > max) {
    let best = { i: 0, j: 1, gap: Number.POSITIVE_INFINITY, size: Number.POSITIVE_INFINITY };
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i] as Box;
        const b = out[j] as Box;
        const gap = Math.hypot(Math.max(0, b.x0 - a.x1, a.x0 - b.x1), Math.max(0, b.y0 - a.y1, a.y0 - b.y1));
        const u = union(a, b);
        const size = (u.x1 - u.x0) * (u.y1 - u.y0);
        if (gap < best.gap || (gap === best.gap && size < best.size)) best = { i, j, gap, size };
      }
    }
    out[best.i] = union(out[best.i] as Box, out[best.j] as Box);
    out.splice(best.j, 1);
  }
  return out;
}

/** The changed pixels of the overlap of the two images, as boxes of nearby changes. */
function changedBoxes(before: Shot, after: Shot, w: number, h: number): Box[] {
  const gw = (w + (1 << CELL_SHIFT) - 1) >> CELL_SHIFT;
  const gh = (h + (1 << CELL_SHIFT) - 1) >> CELL_SHIFT;
  const cells = gw * gh;
  // Per cell: the clear (`fine`) and the strong changes with their bounds, and the summed difference per channel.
  const fine = new Cells(cells);
  const strong = new Cells(cells);
  const sum = new Float64Array(cells * 3);
  let faint = 0;
  let clear = 0;
  const bd = before.data;
  const ad = after.data;
  const b32 = words(bd);
  const a32 = words(ad);
  for (let y = 0; y < h; y++) {
    const rowB = y * before.width;
    const rowA = y * after.width;
    const cellRow = (y >> CELL_SHIFT) * gw;
    for (let x = 0; x < w; x++) {
      const i = (rowB + x) * 4;
      const j = (rowA + x) * 4;
      if (b32 && a32) {
        if (b32[rowB + x] === a32[rowA + x]) continue;
      } else if (
        bd[i] === ad[j] &&
        bd[i + 1] === ad[j + 1] &&
        bd[i + 2] === ad[j + 2] &&
        bd[i + 3] === ad[j + 3]
      )
        continue;
      const ba = bd[i + 3] as number;
      const aa = ad[j + 3] as number;
      const dr = overWhite(ad[j] as number, aa) - overWhite(bd[i] as number, ba);
      const dg = overWhite(ad[j + 1] as number, aa) - overWhite(bd[i + 1] as number, ba);
      const db = overWhite(ad[j + 2] as number, aa) - overWhite(bd[i + 2] as number, ba);
      const c = cellRow + (x >> CELL_SHIFT);
      sum[c * 3] = (sum[c * 3] as number) + dr;
      sum[c * 3 + 1] = (sum[c * 3 + 1] as number) + dg;
      sum[c * 3 + 2] = (sum[c * 3 + 2] as number) + db;
      const d = yiq(dr, dg, db);
      if (d <= FAINT_DELTA) {
        faint++;
        continue;
      }
      clear++;
      fine.add(c, x, y);
      if (d > STRONG_DELTA) strong.add(c, x, y);
    }
  }

  const lossy = faint >= w * h * LOSSY_FAINT_SHARE && faint > clear * LOSSY_FAINT_RATIO;
  // How much each cell changed, in pixels; zero where nothing did.
  const weight = new Int32Array(cells);
  for (let c = 0; c < cells; c++) {
    if (!lossy) {
      weight[c] = fine.count[c] as number;
      continue;
    }
    const cx = c % gw;
    const cy = (c - cx) / gw;
    const area =
      (Math.min(w, (cx + 1) << CELL_SHIFT) - (cx << CELL_SHIFT)) *
      (Math.min(h, (cy + 1) << CELL_SHIFT) - (cy << CELL_SHIFT));
    const shifted =
      yiq(
        (sum[c * 3] as number) / area,
        (sum[c * 3 + 1] as number) / area,
        (sum[c * 3 + 2] as number) / area,
      ) > SHIFT_DELTA;
    weight[c] = (strong.count[c] as number) + (shifted ? area : 0);
    // A shifted cell is outlined where its pixels clearly changed, or whole when they all moved a little.
    if (shifted && strong.count[c] === 0) {
      if ((fine.count[c] as number) > 0) strong.copy(c, fine);
      else
        strong.set(
          c,
          cx << CELL_SHIFT,
          cy << CELL_SHIFT,
          Math.min(w, (cx + 1) << CELL_SHIFT) - 1,
          Math.min(h, (cy + 1) << CELL_SHIFT) - 1,
        );
    }
  }
  const bounds = lossy ? strong : fine;

  // Changed cells, linked to changed cells up to LINK_CELLS away (a dilation without a second grid).
  const seen = new Uint8Array(cells);
  const stack: number[] = [];
  const boxes: Box[] = [];
  for (let start = 0; start < cells; start++) {
    if (weight[start] === 0 || seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    let pixels = 0;
    const box: Box = { x0: w, y0: h, x1: 0, y1: 0 };
    while (stack.length > 0) {
      const c = stack.pop() as number;
      pixels += weight[c] as number;
      box.x0 = Math.min(box.x0, bounds.minX[c] as number);
      box.y0 = Math.min(box.y0, bounds.minY[c] as number);
      box.x1 = Math.max(box.x1, (bounds.maxX[c] as number) + 1);
      box.y1 = Math.max(box.y1, (bounds.maxY[c] as number) + 1);
      const cx = c % gw;
      const cy = (c - cx) / gw;
      for (let ny = Math.max(0, cy - LINK_CELLS); ny <= Math.min(gh - 1, cy + LINK_CELLS); ny++) {
        for (let nx = Math.max(0, cx - LINK_CELLS); nx <= Math.min(gw - 1, cx + LINK_CELLS); nx++) {
          const n = ny * gw + nx;
          if (weight[n] === 0 || seen[n]) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (pixels >= AREA_MIN_PIXELS) boxes.push(box);
  }
  return boxes;
}

/**
 * The areas that changed between two screenshots of one screen, in the after image's pixels, numbered 1…n top to
 * bottom then left to right, at most `COUNCIL_AREAS_MAX`. When the sizes differ the overlap is compared, and what the
 * after image has beyond it is changed too; when the after image is smaller, a band along its cut edge marks it.
 */
export function changedAreas(before: Shot, after: Shot): Area[] {
  const w = Math.min(before.width, after.width);
  const h = Math.min(before.height, after.height);
  let boxes = changedBoxes(before, after, w, h);
  if (after.height > h) boxes.push({ x0: 0, y0: h, x1: after.width, y1: after.height });
  if (after.width > w) boxes.push({ x0: w, y0: 0, x1: after.width, y1: h });
  if (before.height > h)
    boxes.push({ x0: 0, y0: Math.max(0, h - EDGE_BAND), x1: after.width, y1: after.height });
  if (before.width > w)
    boxes.push({ x0: Math.max(0, w - EDGE_BAND), y0: 0, x1: after.width, y1: after.height });

  boxes = mergeNear(boxes, MERGE_GAP);
  // A noisy pair can leave hundreds of small boxes: join them in growing steps before pairing the closest.
  for (let gap = MERGE_GAP * 2; boxes.length > PAIRWISE_MAX; gap *= 2) boxes = mergeNear(boxes, gap);
  boxes = mergeClosest(boxes, COUNCIL_AREAS_MAX);

  boxes.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const rows: Box[][] = [];
  for (const box of boxes) {
    const row = rows.at(-1);
    if (row && box.y0 - (row[0] as Box).y0 <= ROW_TOLERANCE) row.push(box);
    else rows.push([box]);
  }
  return rows
    .flatMap((row) => row.sort((a, b) => a.x0 - b.x0))
    .map((b, i) => ({ n: i + 1, x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 }));
}

/* Drawing the picture -------------------------------------------------------------------------------------------- */

/** The picture is for a phone or a card: wider pairs are scaled down together. */
export const COMPARE_MAX_WIDTH = 1600;
/** Between the halves and beside a narrower half: a mid grey that is neither a light nor a dark screen. */
const BACKDROP = [0x8a, 0x8f, 0x99] as const;
const GAP = 24;
/** The outline: a magenta few interfaces use, so it never reads as part of the screen on light or dark. */
const ACCENT = [0xe0, 0x1b, 0x84] as const;
/** A light line outside and a dark line inside the outline, so it shows on any background, magenta included. */
const HALO_LIGHT = [0xff, 0xff, 0xff] as const;
const HALO_DARK = [0x1a, 0x1a, 0x1a] as const;
/** Digits on the badge. */
const BADGE_TEXT = [0xff, 0xff, 0xff] as const;
const STROKE = 3;
/** Space between the changed pixels and the outline, so the outline never covers them. */
const OUTLINE_SPACE = 2;

/** 5×7 digits 1–9, one string a row, `#` lit. */
const DIGITS: Record<number, readonly string[]> = {
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
};

type Rgb = readonly [number, number, number];

interface Canvas {
  data: Uint8Array;
  width: number;
  height: number;
}

interface Weights {
  start: Int32Array;
  taps: number;
  w: Float32Array;
}

/** Area-filter weights for scaling `from` samples down to `to`: each output sample averages what it covers. */
function weights(from: number, to: number): Weights {
  const ratio = from / to;
  const taps = Math.ceil(ratio) + 1;
  const start = new Int32Array(to);
  const w = new Float32Array(to * taps);
  for (let i = 0; i < to; i++) {
    const s0 = i * ratio;
    const s1 = Math.min(from, (i + 1) * ratio);
    const first = Math.floor(s0);
    start[i] = first;
    for (let t = 0; t < taps; t++) {
      const j = first + t;
      if (j >= from) break;
      const cover = Math.min(j + 1, s1) - Math.max(j, s0);
      if (cover > 0) w[i * taps + t] = cover / (s1 - s0);
    }
  }
  return { start, taps, w };
}

/** Draws `shot` at `top` on the canvas, `w`×`h` (scaled down when smaller), seen over white where transparent. */
function paste(canvas: Canvas, shot: Shot, top: number, w: number, h: number): void {
  const src = shot.data;
  const out = canvas.data;
  if (w === shot.width && h === shot.height) {
    for (let y = 0; y < h; y++) {
      let i = y * shot.width * 4;
      let o = (top + y) * canvas.width * 4;
      for (let x = 0; x < w; x++, i += 4, o += 4) {
        const a = src[i + 3] as number;
        if (a === 255) {
          out[o] = src[i] as number;
          out[o + 1] = src[i + 1] as number;
          out[o + 2] = src[i + 2] as number;
        } else {
          const k = a / 255;
          out[o] = Math.round(255 + ((src[i] as number) - 255) * k);
          out[o + 1] = Math.round(255 + ((src[i + 1] as number) - 255) * k);
          out[o + 2] = Math.round(255 + ((src[i + 2] as number) - 255) * k);
        }
        out[o + 3] = 255;
      }
    }
    return;
  }
  const xs = weights(shot.width, w);
  const ys = weights(shot.height, h);
  // One source row scaled across, kept while the next output row may share it.
  const row = new Float32Array(w * 3);
  let rowAt = -1;
  const acc = new Float32Array(w * 3);
  const across = (sy: number) => {
    row.fill(0);
    const base = sy * shot.width * 4;
    for (let x = 0; x < w; x++) {
      const first = xs.start[x] as number;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let t = 0; t < xs.taps; t++) {
        const k = xs.w[x * xs.taps + t] as number;
        if (k === 0) continue;
        const i = base + (first + t) * 4;
        const a = (src[i + 3] as number) / 255;
        r += k * (255 + ((src[i] as number) - 255) * a);
        g += k * (255 + ((src[i + 1] as number) - 255) * a);
        b += k * (255 + ((src[i + 2] as number) - 255) * a);
      }
      row[x * 3] = r;
      row[x * 3 + 1] = g;
      row[x * 3 + 2] = b;
    }
    rowAt = sy;
  };
  for (let y = 0; y < h; y++) {
    acc.fill(0);
    const first = ys.start[y] as number;
    for (let t = 0; t < ys.taps; t++) {
      const k = ys.w[y * ys.taps + t] as number;
      if (k === 0) continue;
      if (rowAt !== first + t) across(first + t);
      for (let i = 0; i < acc.length; i++) acc[i] = (acc[i] as number) + k * (row[i] as number);
    }
    let o = (top + y) * canvas.width * 4;
    for (let x = 0; x < w; x++, o += 4) {
      out[o] = Math.round(acc[x * 3] as number);
      out[o + 1] = Math.round(acc[x * 3 + 1] as number);
      out[o + 2] = Math.round(acc[x * 3 + 2] as number);
      out[o + 3] = 255;
    }
  }
}

function fillRect(canvas: Canvas, x0: number, y0: number, x1: number, y1: number, color: Rgb): void {
  const out = canvas.data;
  for (let y = Math.max(0, y0); y < Math.min(canvas.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(canvas.width, x1); x++) {
      const o = (y * canvas.width + x) * 4;
      out[o] = color[0];
      out[o + 1] = color[1];
      out[o + 2] = color[2];
      out[o + 3] = 255;
    }
  }
}

/** A one-pixel rectangle line along the inside of the box. */
function frame(canvas: Canvas, b: Box, color: Rgb): void {
  if (b.x1 <= b.x0 || b.y1 <= b.y0) return;
  fillRect(canvas, b.x0, b.y0, b.x1, b.y0 + 1, color);
  fillRect(canvas, b.x0, b.y1 - 1, b.x1, b.y1, color);
  fillRect(canvas, b.x0, b.y0, b.x0 + 1, b.y1, color);
  fillRect(canvas, b.x1 - 1, b.y0, b.x1, b.y1, color);
}

function inset(b: Box, by: number): Box {
  return { x0: b.x0 + by, y0: b.y0 + by, x1: b.x1 - by, y1: b.y1 - by };
}

/** The outline's outer edge for `area` on one half, kept inside that half so an area at the edge keeps its outline. */
function outlineBox(area: Area, scale: number, half: Box): Box | null {
  const ring = OUTLINE_SPACE + STROKE + 2;
  const x0 = half.x0 + Math.floor(area.x * scale) - ring;
  const y0 = half.y0 + Math.floor(area.y * scale) - ring;
  const x1 = half.x0 + Math.ceil((area.x + area.w) * scale) + ring;
  const y1 = half.y0 + Math.ceil((area.y + area.h) * scale) + ring;
  // An area beyond this half (the part a taller after image adds) is drawn on the other half only.
  if (x0 + ring >= half.x1 || y0 + ring >= half.y1) return null;
  return {
    x0: Math.max(half.x0, x0),
    y0: Math.max(half.y0, y0),
    x1: Math.min(half.x1, x1),
    y1: Math.min(half.y1, y1),
  };
}

function drawOutline(canvas: Canvas, outer: Box): void {
  frame(canvas, outer, HALO_LIGHT);
  for (let i = 1; i <= STROKE; i++) frame(canvas, inset(outer, i), ACCENT);
  frame(canvas, inset(outer, STROKE + 1), HALO_DARK);
}

function blend(canvas: Canvas, x: number, y: number, color: Rgb, alpha: number): void {
  if (alpha <= 0 || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const o = (y * canvas.width + x) * 4;
  const out = canvas.data;
  const k = Math.min(1, alpha);
  out[o] = Math.round((out[o] as number) + (color[0] - (out[o] as number)) * k);
  out[o + 1] = Math.round((out[o + 1] as number) + (color[1] - (out[o + 1] as number)) * k);
  out[o + 2] = Math.round((out[o + 2] as number) + (color[2] - (out[o + 2] as number)) * k);
}

/** Digits are drawn this many pixels a glyph pixel: big enough to read when the picture is shown on a phone. */
function digitScale(width: number): number {
  return Math.max(2, Math.min(6, Math.round((width * 0.024) / 7)));
}

/**
 * A round badge with the area's number just outside the outline's top-left corner, overlapping only the outline so a
 * small area stays visible; kept inside the half, where it covers the area's corner instead.
 */
function drawBadge(canvas: Canvas, n: number, outer: Box, half: Box, k: number): void {
  const glyph = DIGITS[n];
  if (!glyph) return;
  const radius = k * 6;
  const out = Math.round(radius * 0.7);
  const cx = Math.max(half.x0 + radius, Math.min(half.x1 - radius, outer.x0 + STROKE - out));
  const cy = Math.max(half.y0 + radius, Math.min(half.y1 - radius, outer.y0 + STROKE - out));
  for (let y = cy - radius - 1; y <= cy + radius + 1; y++) {
    for (let x = cx - radius - 1; x <= cx + radius + 1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      blend(canvas, x, y, HALO_LIGHT, radius + 0.5 - d);
      blend(canvas, x, y, ACCENT, radius - 1.5 - d);
    }
  }
  const left = Math.round(cx - (5 * k) / 2);
  const top = Math.round(cy - (7 * k) / 2);
  glyph.forEach((line, gy) => {
    for (let gx = 0; gx < line.length; gx++)
      if (line[gx] === '#')
        fillRect(canvas, left + gx * k, top + gy * k, left + (gx + 1) * k, top + (gy + 1) * k, BADGE_TEXT);
  });
}

/**
 * One PNG: `before` on top, a grey gap, `after` below, both scaled down together past `COMPARE_MAX_WIDTH`, each
 * area outlined and numbered at the same place on both halves.
 */
export function drawCompare(
  before: Shot,
  after: Shot,
  areas: Area[],
): { png: Buffer; width: number; height: number } {
  const scale = Math.min(1, COMPARE_MAX_WIDTH / Math.max(before.width, after.width));
  const bw = Math.max(1, Math.round(before.width * scale));
  const bh = Math.max(1, Math.round(before.height * scale));
  const aw = Math.max(1, Math.round(after.width * scale));
  const ah = Math.max(1, Math.round(after.height * scale));
  const width = Math.max(bw, aw);
  const height = bh + GAP + ah;
  const data = new Uint8Array(width * height * 4);
  for (let o = 0; o < data.length; o += 4) {
    data[o] = BACKDROP[0];
    data[o + 1] = BACKDROP[1];
    data[o + 2] = BACKDROP[2];
    data[o + 3] = 255;
  }
  const canvas: Canvas = { data, width, height };
  paste(canvas, before, 0, bw, bh);
  paste(canvas, after, bh + GAP, aw, ah);

  const halves: Box[] = [
    { x0: 0, y0: 0, x1: bw, y1: bh },
    { x0: 0, y0: bh + GAP, x1: aw, y1: height },
  ];
  const k = digitScale(width);
  const marks = halves.flatMap((half) =>
    areas.flatMap((area) => {
      const outer = outlineBox(area, scale, half);
      return outer ? [{ area, outer, half }] : [];
    }),
  );
  // Every outline before any badge, so a badge is never crossed by a neighbour's outline.
  for (const m of marks) drawOutline(canvas, m.outer);
  for (const m of marks) drawBadge(canvas, m.area.n, m.outer, m.half, k);

  const png = new PNG({ width, height });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const bytes = PNG.sync.write(png, {
    colorType: 2,
    inputColorType: 6,
    inputHasAlpha: true,
    bitDepth: 8,
    deflateLevel: 6,
  });
  return { png: bytes, width, height };
}

/* Words ---------------------------------------------------------------------------------------------------------- */

/** Where an area is on its screen in plain words (“top left”, “across the middle”, “most of the screen”). */
export function whereOf(area: Area, width: number, height: number): string {
  const wide = area.w >= width * 0.7;
  const tall = area.h >= height * 0.7;
  if (wide && tall) return 'most of the screen';
  const third = (at: number, size: number) => (at < size / 3 ? 0 : at < (size * 2) / 3 ? 1 : 2);
  const row = third(area.y + area.h / 2, height);
  const col = third(area.x + area.w / 2, width);
  if (wide) return ['across the top', 'across the middle', 'across the bottom'][row] as string;
  if (tall) return ['down the left side', 'down the middle', 'down the right side'][col] as string;
  const across = ['left', '', 'right'][col] as string;
  const down = ['top', '', 'bottom'][row] as string;
  return [down, across].filter(Boolean).join(' ') || 'middle';
}
