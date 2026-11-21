import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { COUNCIL_AREAS_MAX } from '@whombat/core';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { type Area, changedAreas, decodeShot, drawCompare, type Shot, ShotError, whereOf } from './shots';

/* A UI-like page: flat fills, cards with borders, buttons and lines of text-like strokes. -------------------------- */

type Rgb = [number, number, number];

const LIGHT = {
  page: [0xf8, 0xfa, 0xfc] as Rgb,
  side: [0xe2, 0xe8, 0xf0] as Rgb,
  card: [0xff, 0xff, 0xff] as Rgb,
  border: [0xe5, 0xe7, 0xeb] as Rgb,
  text: [0x33, 0x41, 0x55] as Rgb,
  button: [0x25, 0x63, 0xeb] as Rgb,
  buttonText: [0xff, 0xff, 0xff] as Rgb,
  header: [0xf8, 0xfa, 0xfc] as Rgb,
  firstLine: [0x33, 0x41, 0x55] as Rgb,
};
const DARK = {
  page: [0x0f, 0x17, 0x2a] as Rgb,
  side: [0x1e, 0x29, 0x3b] as Rgb,
  card: [0x11, 0x18, 0x27] as Rgb,
  border: [0x33, 0x41, 0x55] as Rgb,
  text: [0xe2, 0xe8, 0xf0] as Rgb,
  button: [0x60, 0xa5, 0xfa] as Rgb,
  buttonText: [0x0f, 0x17, 0x2a] as Rgb,
  header: [0x0f, 0x17, 0x2a] as Rgb,
  firstLine: [0xe2, 0xe8, 0xf0] as Rgb,
};
type Theme = typeof LIGHT;

function blank(width: number, height: number, color: Rgb): Shot {
  const data = new Uint8Array(width * height * 4);
  for (let o = 0; o < data.length; o += 4) {
    data[o] = color[0];
    data[o + 1] = color[1];
    data[o + 2] = color[2];
    data[o + 3] = 255;
  }
  return { width, height, data };
}

function copy(shot: Shot): Shot {
  return { width: shot.width, height: shot.height, data: shot.data.slice() };
}

function rect(shot: Shot, x: number, y: number, w: number, h: number, color: Rgb, alpha = 1): void {
  for (let yy = Math.max(0, y); yy < Math.min(shot.height, y + h); yy++)
    for (let xx = Math.max(0, x); xx < Math.min(shot.width, x + w); xx++) {
      const o = (yy * shot.width + xx) * 4;
      for (let c = 0; c < 3; c++)
        shot.data[o + c] = Math.round((shot.data[o + c] as number) * (1 - alpha) + color[c as 0] * alpha);
    }
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A line of “words”: glyph-like strokes 1–2 px wide with soft (anti-aliased) edges. */
function text(shot: Shot, x: number, y: number, width: number, color: Rgb, seed: number, size = 10): void {
  const rnd = seeded(seed);
  let at = x;
  while (at < x + width - 12) {
    const word = 12 + Math.floor(rnd() * 50);
    const end = Math.min(x + width, at + word);
    for (let gx = at; gx < end; gx += 2 + Math.floor(rnd() * 3)) {
      const top = y + Math.floor(rnd() * 3);
      const tall = size - Math.floor(rnd() * 4);
      rect(shot, gx, top, 1, tall, color);
      rect(shot, gx + 1, top + 2, 1, tall - 3, color, 0.45);
      if (rnd() < 0.4) rect(shot, gx, top + Math.floor(tall / 2), 3, 1, color, 0.7);
    }
    at = end + 6;
  }
}

function button(shot: Shot, t: Theme, x: number, y: number, w: number, h: number, seed: number): void {
  rect(shot, x, y, w, h, t.button);
  // Rounded-ish corners: the corner pixel blended with the page.
  for (const [cx, cy] of [
    [x, y],
    [x + w - 1, y],
    [x, y + h - 1],
    [x + w - 1, y + h - 1],
  ] as const)
    rect(shot, cx, cy, 1, 1, t.card, 0.6);
  text(shot, x + 14, y + Math.floor(h / 2) - 5, w - 28, t.buttonText, seed);
}

/** A settings-like page, 1440×900 unless asked; a change is a theme with one colour changed, or drawn on top. */
function page(t: Theme = LIGHT, width = 1440, height = 900): Shot {
  const shot = blank(width, height, t.page);
  rect(shot, 0, 0, 240, height, t.side);
  for (let i = 0; i < 12; i++) text(shot, 24, 90 + i * 36, 150, t.text, 100 + i);
  rect(shot, 240, 0, width - 240, 64, t.header);
  rect(shot, 240, 64, width - 240, 1, t.border);
  text(shot, 272, 26, 220, t.text, 7, 14);
  for (let card = 0; card * 260 + 96 < height - 40; card++) {
    const top = 96 + card * 260;
    rect(shot, 272, top, width - 272 - 48, 230, t.border);
    rect(shot, 273, top + 1, width - 272 - 50, 228, t.card);
    for (let line = 0; line < 5; line++)
      text(shot, 300, top + 28 + line * 26, 560, card + line === 0 ? t.firstLine : t.text, card * 10 + line);
    button(shot, t, width - 48 - 32 - 140, top + 170, 140, 36, card + 50);
    button(shot, t, width - 48 - 32 - 140 - 12 - 110, top + 170, 110, 36, card + 60);
  }
  return shot;
}

function jpegOf(shot: Shot, quality: number): Buffer {
  return Buffer.from(
    jpeg.encode({ width: shot.width, height: shot.height, data: shot.data as Buffer }, quality).data,
  );
}

function pngOf(shot: Shot): Buffer {
  const png = new PNG({ width: shot.width, height: shot.height });
  png.data = Buffer.from(shot.data);
  return PNG.sync.write(png);
}

function at(shot: { width: number; data: Uint8Array }, x: number, y: number): Rgb {
  const o = (y * shot.width + x) * 4;
  return [shot.data[o] as number, shot.data[o + 1] as number, shot.data[o + 2] as number];
}

/** Whether the area covers the rectangle, with `slack` pixels of rounding either way. */
function covers(area: Area, x: number, y: number, w: number, h: number, slack = 0): boolean {
  return (
    area.x <= x + slack &&
    area.y <= y + slack &&
    area.x + area.w >= x + w - slack &&
    area.y + area.h >= y + h - slack
  );
}

/** The outline's colour: strongly magenta. */
function isAccent([r, g, b]: Rgb): boolean {
  return r > 180 && g < 80 && b > 80;
}

/** The first card's primary button, moved 16 px to the right. */
const BUTTON = { x: 1440 - 48 - 32 - 140, y: 96 + 170, w: 140, h: 36 };
function movedButton(t: Theme = LIGHT): Shot {
  const shot = page(t);
  rect(shot, BUTTON.x, BUTTON.y, BUTTON.w, BUTTON.h, t.card);
  button(shot, t, BUTTON.x + 16, BUTTON.y, BUTTON.w, BUTTON.h, 50);
  return shot;
}

function decodedPng(png: Buffer): Shot {
  const img = PNG.sync.read(png);
  return { width: img.width, height: img.height, data: img.data };
}

function refusal(fn: () => unknown): ShotError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ShotError) return err;
    throw err;
  }
  throw new Error('not refused');
}

/* Tests ------------------------------------------------------------------------------------------------------------ */

describe('decodeShot', () => {
  it('decodes PNG and JPEG screenshots to RGBA', () => {
    const shot = page(LIGHT, 320, 200);
    const png = decodeShot(pngOf(shot), 'image/png');
    expect(png).toMatchObject({ width: 320, height: 200 });
    expect(Buffer.from(png.data).equals(Buffer.from(shot.data))).toBe(true);
    const jpg = decodeShot(jpegOf(shot, 90), 'image/jpeg');
    expect(jpg).toMatchObject({ width: 320, height: 200 });
    expect(jpg.data.length).toBe(320 * 200 * 4);
  });

  it('refuses what is not an image of the type it says', () => {
    const png = pngOf(page(LIGHT, 64, 48));
    const jpg = jpegOf(page(LIGHT, 64, 48), 90);
    expect(refusal(() => decodeShot(Buffer.from('not a picture at all'), 'image/png')).reason).toBe(
      'malformed',
    );
    expect(refusal(() => decodeShot(png, 'image/jpeg')).reason).toBe('malformed');
    expect(refusal(() => decodeShot(jpg, 'image/png')).message).toContain('PNG');
    expect(refusal(() => decodeShot(png.subarray(0, png.length >> 1), 'image/png')).reason).toBe('malformed');
    expect(refusal(() => decodeShot(jpg.subarray(0, jpg.length >> 1), 'image/jpeg')).reason).toBe(
      'malformed',
    );
    // A damaged byte inside the image data fails its checksum.
    const damaged = Buffer.from(png);
    damaged[60] = (damaged[60] as number) ^ 0xff;
    expect(refusal(() => decodeShot(damaged, 'image/png')).reason).toBe('malformed');
  });

  it('refuses screenshots too large to compare, before decoding them', () => {
    expect(refusal(() => decodeShot(pngOf(blank(6001, 2, LIGHT.page)), 'image/png')).reason).toBe(
      'too_large',
    );
    expect(refusal(() => decodeShot(jpegOf(blank(8, 6001, LIGHT.page), 80), 'image/jpeg')).reason).toBe(
      'too_large',
    );
    // A small file whose header claims 5000 × 5000 (25 megapixels): refused from the header alone.
    const claim = Buffer.from(pngOf(blank(10, 10, LIGHT.page)));
    claim.writeUInt32BE(5000, 16);
    claim.writeUInt32BE(5000, 20);
    const err = refusal(() => decodeShot(claim, 'image/png'));
    expect(err.reason).toBe('too_large');
    expect(err.message).toContain('6000');
  });
});

describe('changedAreas', () => {
  it('finds nothing in identical screenshots', () => {
    for (const t of [LIGHT, DARK]) {
      const before = page(t);
      expect(changedAreas(before, copy(before))).toEqual([]);
    }
  });

  it('finds one area around a button that moved', () => {
    for (const t of [LIGHT, DARK]) {
      const areas = changedAreas(page(t), movedButton(t));
      expect(areas).toHaveLength(1);
      const [area] = areas as [Area];
      expect(area.n).toBe(1);
      expect(covers(area, BUTTON.x, BUTTON.y, BUTTON.w + 16, BUTTON.h, 1)).toBe(true);
      expect(area.w).toBeLessThanOrEqual(BUTTON.w + 16 + 4);
      expect(area.h).toBeLessThanOrEqual(BUTTON.h + 4);
    }
  });

  it('finds one area around a button that grew', () => {
    const after = page();
    button(after, LIGHT, BUTTON.x, BUTTON.y, BUTTON.w, BUTTON.h + 8, 50);
    const areas = changedAreas(page(), after);
    expect(areas).toHaveLength(1);
    const [area] = areas as [Area];
    expect(
      covers(
        { n: 1, x: BUTTON.x, y: BUTTON.y, w: BUTTON.w, h: BUTTON.h + 8 },
        area.x,
        area.y,
        area.w,
        area.h,
      ),
    ).toBe(true);
    expect(covers(area, BUTTON.x, BUTTON.y + BUTTON.h, BUTTON.w, 8, 1)).toBe(true);
  });

  it('finds one area around a button that grew both ways', () => {
    const after = page();
    button(after, LIGHT, BUTTON.x, BUTTON.y - 4, BUTTON.w, BUTTON.h + 8, 50);
    const areas = changedAreas(page(), after);
    expect(areas).toHaveLength(1);
    expect(covers(areas[0] as Area, BUTTON.x, BUTTON.y - 4, BUTTON.w, BUTTON.h + 8, 1)).toBe(true);
  });

  it('numbers far-apart changes top to bottom', () => {
    const after = page();
    text(after, 24, 90 + 11 * 36, 150, LIGHT.text, 999);
    text(after, 272, 26, 220, LIGHT.text, 8, 14);
    const areas = changedAreas(page(), after);
    expect(areas.map((a) => a.n)).toEqual([1, 2]);
    expect(covers(areas[0] as Area, 280, 30, 180, 6)).toBe(true);
    expect(covers(areas[1] as Area, 30, 90 + 11 * 36 + 3, 100, 4)).toBe(true);
  });

  it('numbers a row left to right', () => {
    const before = blank(1440, 900, LIGHT.card);
    const after = copy(before);
    for (const [x, y] of [
      [900, 400],
      [500, 410],
      [700, 395],
      [100, 600],
    ] as const)
      rect(after, x, y, 12, 12, LIGHT.text);
    expect(changedAreas(before, after).map((a) => [a.n, a.x])).toEqual([
      [1, 500],
      [2, 700],
      [3, 900],
      [4, 100],
    ]);
  });

  it('finds subtle changes between lossless screenshots', () => {
    for (const t of [LIGHT, DARK]) {
      const shade = (c: Rgb): Rgb =>
        t === LIGHT ? (c.map((v) => v - 20) as Rgb) : (c.map((v) => v + 20) as Rgb);
      const before = page(t);
      // The first line's text, every border, the header's background: each a shade different.
      const line = changedAreas(before, page({ ...t, firstLine: shade(t.firstLine) }));
      expect(line).toHaveLength(1);
      expect(covers(line[0] as Area, 310, 96 + 30, 500, 6)).toBe(true);
      const borders = changedAreas(before, page({ ...t, border: shade(t.border) }));
      for (const top of [96, 356, 616])
        expect(borders.some((a) => covers(a, 272, top, 1120, 230))).toBe(true);
      const header = changedAreas(before, page({ ...t, header: shade(t.header) }));
      expect(header).toHaveLength(1);
      expect(covers(header[0] as Area, 240, 0, 1200, 64, 1)).toBe(true);
    }
  });

  it('ignores the noise of a JPEG re-encode', () => {
    for (const t of [LIGHT, DARK]) {
      const before = page(t);
      for (const quality of [75, 85, 92])
        expect(changedAreas(before, decodeShot(jpegOf(before, quality), 'image/jpeg'))).toEqual([]);
    }
  });

  it('still finds a moved button through JPEG noise', () => {
    for (const t of [LIGHT, DARK]) {
      const after = decodeShot(jpegOf(movedButton(t), 80), 'image/jpeg');
      const areas = changedAreas(page(t), after);
      expect(areas).toHaveLength(1);
      expect(covers(areas[0] as Area, BUTTON.x, BUTTON.y, BUTTON.w + 16, BUTTON.h, 2)).toBe(true);
    }
  });

  it('drops a few stray pixels', () => {
    const before = blank(800, 600, LIGHT.card);
    const after = copy(before);
    rect(after, 100, 100, 1, 1, LIGHT.text);
    rect(after, 400, 300, 2, 2, LIGHT.text);
    expect(changedAreas(before, after)).toEqual([]);
    rect(after, 600, 500, 3, 3, LIGHT.text);
    expect(changedAreas(before, after)).toEqual([{ n: 1, x: 600, y: 500, w: 3, h: 3 }]);
  });

  it('keeps at most nine areas, covering every change', () => {
    const before = blank(1440, 900, LIGHT.card);
    const after = copy(before);
    const spots: [number, number][] = [];
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 3; j++) {
        spots.push([100 + i * 280, 100 + j * 300]);
        rect(after, 100 + i * 280, 100 + j * 300, 6, 6, LIGHT.button);
      }
    const areas = changedAreas(before, after);
    expect(areas).toHaveLength(COUNCIL_AREAS_MAX);
    expect(areas.map((a) => a.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const [x, y] of spots) expect(areas.some((a) => covers(a, x, y, 6, 6))).toBe(true);
  });

  it('stays quick with thousands of scattered changes', () => {
    const before = blank(1440, 900, LIGHT.card);
    const after = copy(before);
    for (let y = 4; y < 900; y += 24) for (let x = 4; x < 1440; x += 24) rect(after, x, y, 3, 3, LIGHT.text);
    const started = performance.now();
    const areas = changedAreas(before, after);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(areas.length).toBeGreaterThan(0);
    expect(areas.length).toBeLessThanOrEqual(COUNCIL_AREAS_MAX);
  });

  it('marks what a taller or wider after image adds, and where a shorter one ends', () => {
    expect(changedAreas(blank(1440, 900, LIGHT.page), blank(1440, 1100, LIGHT.page))).toEqual([
      { n: 1, x: 0, y: 900, w: 1440, h: 200 },
    ]);
    expect(changedAreas(blank(1000, 900, LIGHT.page), blank(1440, 900, LIGHT.page))).toEqual([
      { n: 1, x: 1000, y: 0, w: 440, h: 900 },
    ]);
    expect(changedAreas(blank(1440, 1000, LIGHT.page), blank(1440, 900, LIGHT.page))).toEqual([
      { n: 1, x: 0, y: 884, w: 1440, h: 16 },
    ]);
    // A page that got taller: its new card starts inside the overlap, and joins the added part.
    const areas = changedAreas(page(LIGHT, 1440, 900), page(LIGHT, 1440, 1100));
    expect(areas).toHaveLength(1);
    expect(covers(areas[0] as Area, 272, 876, 1120, 224)).toBe(true);
  });
});

describe('drawCompare', () => {
  it('draws before above after with each area outlined at the same place on both', () => {
    const before = page();
    const after = movedButton();
    const areas = changedAreas(before, after);
    const out = drawCompare(before, after, areas);
    expect(out).toMatchObject({ width: 1440, height: 900 + 24 + 900 });
    const img = decodedPng(out.png);
    expect(img).toMatchObject({ width: out.width, height: out.height });
    const top = 900 + 24;
    for (const a of areas) {
      const right = a.x + a.w + 4;
      const middle = a.y + Math.floor(a.h / 2);
      expect(isAccent(at(img, right, middle))).toBe(true);
      expect(isAccent(at(img, right, top + middle))).toBe(true);
      // The number's badge by the top-left corner: magenta with light digits.
      let accent = 0;
      let light = 0;
      for (let y = a.y - 50; y < a.y + 10; y++)
        for (let x = a.x - 50; x < a.x + 10; x++) {
          const c = at(img, x, top + y);
          if (isAccent(c)) accent++;
          if (c.every((v) => v > 240)) light++;
        }
      expect(accent).toBeGreaterThan(400);
      expect(light).toBeGreaterThan(40);
    }
    // Away from the areas each half is its screenshot, and the gap between them is a neutral grey.
    expect(at(img, 600, 500)).toEqual(at(before, 600, 500));
    expect(at(img, 600, top + 500)).toEqual(at(after, 600, 500));
    const [r, g, b] = at(img, 700, 900 + 12);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(24);
    expect(r).toBeGreaterThan(100);
    expect(r).toBeLessThan(180);
  });

  it('scales a wide pair down together', () => {
    const before = blank(2000, 600, LIGHT.card);
    const after = copy(before);
    rect(after, 1000, 300, 200, 100, LIGHT.button);
    const areas = changedAreas(before, after);
    const out = drawCompare(before, after, areas);
    expect(out).toMatchObject({ width: 1600, height: 480 + 24 + 480 });
    const img = decodedPng(out.png);
    // The button, scaled by 0.8, sits at (800, 240) on the after half; the area's outline is beside it on both halves.
    expect(at(img, 880, 504 + 280)).toEqual(LIGHT.button);
    expect(at(img, 880, 280)).toEqual(LIGHT.card);
    expect(isAccent(at(img, 960 + 4, 280))).toBe(true);
    expect(isAccent(at(img, 960 + 4, 504 + 280))).toBe(true);
  });

  it('outlines what a taller after image adds on the after half only', () => {
    const before = blank(1440, 900, LIGHT.card);
    const after = blank(1440, 1100, LIGHT.card);
    const out = drawCompare(before, after, changedAreas(before, after));
    expect(out).toMatchObject({ width: 1440, height: 900 + 24 + 1100 });
    const img = decodedPng(out.png);
    expect(at(img, 720, 899)).toEqual(LIGHT.card);
    expect(isAccent(at(img, 720, 924 + 900 - 5))).toBe(true);
  });

  it('draws a realistic pair quickly', () => {
    const before = page();
    const after = movedButton();
    text(after, 272, 26, 220, LIGHT.text, 8, 14);
    const started = performance.now();
    drawCompare(before, after, changedAreas(before, after));
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe('whereOf', () => {
  const where = (x: number, y: number, w: number, h: number) => whereOf({ n: 1, x, y, w, h }, 1440, 900);

  it('says where an area is in plain words', () => {
    expect(where(10, 10, 100, 40)).toBe('top left');
    expect(where(700, 10, 40, 40)).toBe('top');
    expect(where(1300, 10, 100, 40)).toBe('top right');
    expect(where(10, 430, 100, 40)).toBe('left');
    expect(where(700, 430, 40, 40)).toBe('middle');
    expect(where(1300, 800, 100, 40)).toBe('bottom right');
    expect(where(0, 0, 1440, 64)).toBe('across the top');
    expect(where(0, 0, 240, 900)).toBe('down the left side');
    expect(where(0, 0, 1440, 900)).toBe('most of the screen');
  });

  it('keeps it short', () => {
    for (let x = 0; x < 1440; x += 120)
      for (let y = 0; y < 900; y += 90)
        for (const [w, h] of [
          [20, 20],
          [1440 - x, 40],
          [40, 900 - y],
        ] as const)
          expect(where(x, y, w, h).length).toBeLessThanOrEqual(60);
  });
});

/* A sample picture to look at: COUNCIL_SHOTS_SAMPLE=1 writes it to ~/.cache/wb-tmp/council-shots/. ------------------ */

describe.runIf(process.env.COUNCIL_SHOTS_SAMPLE)('sample', () => {
  it('writes sample pictures and timings', () => {
    const dir = join(homedir(), '.cache/wb-tmp/council-shots');
    mkdirSync(dir, { recursive: true });
    const timings: string[] = [];
    for (const [name, t] of [
      ['sample', LIGHT],
      ['sample-dark', DARK],
    ] as const) {
      const before = page(t);
      const after = page({ ...t, firstLine: t === LIGHT ? [0x64, 0x74, 0x8b] : [0x94, 0xa3, 0xb8] });
      rect(after, BUTTON.x, BUTTON.y, BUTTON.w, BUTTON.h, t.card);
      button(after, t, BUTTON.x, BUTTON.y - 4, BUTTON.w, BUTTON.h + 8, 50);
      text(after, 272, 26, 220, t.text, 8, 14);
      rect(after, 24, 90 + 5 * 36 - 8, 190, 26, t.button, 0.15);
      text(after, 24, 90 + 5 * 36, 150, t.text, 105);
      rect(after, 1300, 870 - 14, 44, 24, t.button);
      rect(after, 1322, 870 - 12, 20, 20, t.buttonText);
      const started = performance.now();
      const areas = changedAreas(before, after);
      const diffed = performance.now();
      const out = drawCompare(before, after, areas);
      const done = performance.now();
      writeFileSync(join(dir, `${name}.png`), out.png);
      timings.push(
        `${name}: ${areas.length} areas, diff ${(diffed - started).toFixed(0)} ms, draw+encode ${(done - diffed).toFixed(0)} ms, ${out.width}×${out.height}, ${(out.png.length / 1024).toFixed(0)} KB`,
        ...areas.map((a) => `  ${a.n}. ${whereOf(a, after.width, after.height)} ${JSON.stringify(a)}`),
      );
    }
    const before = page(LIGHT, 2880, 1800);
    const after = page(LIGHT, 2880, 1800);
    text(after, 272, 26, 220, LIGHT.text, 8, 14);
    const started = performance.now();
    const out = drawCompare(before, after, changedAreas(before, after));
    timings.push(
      `2880×1800 pair: ${(performance.now() - started).toFixed(0)} ms, ${out.width}×${out.height}`,
    );
    writeFileSync(join(dir, 'sample-wide.png'), out.png);
    writeFileSync(join(dir, 'timings.txt'), `${timings.join('\n')}\n`);
  });
});
