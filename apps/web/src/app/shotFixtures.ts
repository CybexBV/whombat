/**
 * The picture of what changed that fixture mode shows (Whombat council.md CNL-32, delegate.md DLG-27): a settings page
 * before (top) and after (bottom), its two changed areas outlined and numbered on both, as Whombat draws one from a
 * task's shots. The council's final card and the delegation's first task show it, each as a file of its card's message.
 */
import { encodePng } from '@whombat/fixtures';

let bytes: Uint8Array | null = null;
/** The picture's PNG, drawn once: what the fixture world answers for a picture's attachment. */
export function shotPictureBytes(): Uint8Array {
  bytes ??= shotPicture();
  return bytes;
}

/** The picture's size: a settings page before (top) and after (bottom), drawn small. */
export const SHOT = { width: 480, height: 600 };

type Rgb = readonly [number, number, number];
const PAPER: Rgb = [247, 243, 236];
const SIDE: Rgb = [238, 232, 223];
const INK: Rgb = [43, 37, 32];
const SOFT: Rgb = [196, 187, 175];
const BUTTON: Rgb = [43, 37, 32];
const SWITCH: Rgb = [111, 207, 151];
const MARK: Rgb = [232, 89, 12];
const WHITE: Rgb = [255, 255, 255];
const RULE: Rgb = [214, 206, 195];

/** 3×5 bitmaps of the area numbers. */
const DIGITS: Record<number, string[]> = {
  1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['##.', '..#', '.#.', '#..', '###'],
};

/**
 * The before-and-after picture Whombat draws for a screen (CNL-32), here by hand: a settings page twice, its two
 * changed areas outlined and numbered on both (the side list's renamed section, the taller buttons).
 */
export function shotPicture(): Uint8Array {
  const { width, height } = SHOT;
  const rgb = new Uint8Array(width * height * 3);
  const rect = (x: number, y: number, w: number, h: number, c: Rgb) => {
    for (let j = Math.max(0, y); j < Math.min(height, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(width, x + w); i++) rgb.set(c, (j * width + i) * 3);
  };
  const outline = (x: number, y: number, w: number, h: number, c: Rgb) => {
    rect(x, y, w, 2, c);
    rect(x, y + h - 2, w, 2, c);
    rect(x, y, 2, h, c);
    rect(x + w - 2, y, 2, h, c);
  };
  const disc = (cx: number, cy: number, r: number, c: Rgb) => {
    for (let j = -r; j <= r; j++)
      for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r) rect(cx + i, cy + j, 1, 1, c);
  };
  const badge = (cx: number, cy: number, d: number) => {
    disc(cx, cy, 9, MARK);
    (DIGITS[d] ?? []).forEach((row, j) => {
      [...row].forEach((p, i) => {
        if (p === '#') rect(cx - 3 + i * 2, cy - 5 + j * 2, 2, 2, WHITE);
      });
    });
  };
  const page = (top: number, after: boolean) => {
    const half = height / 2;
    rect(0, top, width, half, PAPER);
    rect(0, top, 120, half, SIDE);
    // The side list: five sections, the fourth renamed (wider) after.
    for (let k = 0; k < 5; k++)
      rect(16, top + 40 + k * 26, k === 3 ? (after ? 84 : 48) : 56 + ((k * 13) % 24), 8, SOFT);
    // The page's title and three settings, each with its switch or button.
    rect(148, top + 28, 150, 14, INK);
    for (let k = 0; k < 3; k++) {
      const y = top + 74 + k * 62;
      rect(148, y, 120 + k * 18, 9, INK);
      rect(148, y + 16, 200, 7, SOFT);
      rect(148, y + 46, width - 172, 1, RULE);
      if (k === 1) rect(width - 66, y + 2, 34, 18, SWITCH);
      else rect(width - 96, after ? y - 4 : y, 70, after ? 30 : 18, BUTTON);
    }
    // The changed areas, outlined and numbered on both halves.
    outline(8, top + 112, 104, 24, MARK);
    badge(112, top + 112, 1);
    outline(width - 106, top + 62, 92, 152, MARK);
    badge(width - 14, top + 62, 2);
  };
  page(0, false);
  page(height / 2, true);
  rect(0, height / 2 - 1, width, 2, RULE);
  return encodePng(width, height, rgb);
}
