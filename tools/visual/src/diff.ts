import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface DiffResult {
  width: number;
  height: number;
  mismatched: number;
  /** Percentage of mismatched pixels, 0–100. */
  percent: number;
  sizeMatches: boolean;
  diff: Buffer;
}

function pad(img: PNG, width: number, height: number): PNG {
  if (img.width === width && img.height === height) return img;
  const out = new PNG({ width, height });
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
  return out;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Cut a region out of a PNG (clamped to the image). */
export function cropPng(png: Buffer, rect: Rect): Buffer {
  const img = PNG.sync.read(png);
  const x = Math.max(0, Math.min(rect.x, img.width));
  const y = Math.max(0, Math.min(rect.y, img.height));
  const width = Math.max(0, Math.min(rect.width, img.width - x));
  const height = Math.max(0, Math.min(rect.height, img.height - y));
  const out = new PNG({ width, height });
  PNG.bitblt(img, out, x, y, width, height, 0, 0);
  return PNG.sync.write(out);
}

/**
 * Paint regions a solid color so a comparison ignores them (deliberate differences such as icons
 * that replace the mock's placeholder glyphs). Apply the same masks to both images.
 */
export function maskPng(
  png: Buffer,
  rects: readonly Rect[],
  rgba: readonly number[] = [255, 0, 255, 255],
): Buffer {
  const img = PNG.sync.read(png);
  for (const r of rects) {
    for (let y = Math.max(0, r.y); y < Math.min(img.height, r.y + r.height); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(img.width, r.x + r.width); x++) {
        const i = (y * img.width + x) * 4;
        img.data[i] = rgba[0] ?? 0;
        img.data[i + 1] = rgba[1] ?? 0;
        img.data[i + 2] = rgba[2] ?? 0;
        img.data[i + 3] = rgba[3] ?? 255;
      }
    }
  }
  return PNG.sync.write(img);
}

/** Compare two PNGs (padded to the larger size) and return the mismatch and a diff image. */
export function diffPng(a: Buffer, b: Buffer, threshold = 0.1): DiffResult {
  const imgA = PNG.sync.read(a);
  const imgB = PNG.sync.read(b);
  const width = Math.max(imgA.width, imgB.width);
  const height = Math.max(imgA.height, imgB.height);
  const out = new PNG({ width, height });
  const mismatched = pixelmatch(
    pad(imgA, width, height).data,
    pad(imgB, width, height).data,
    out.data,
    width,
    height,
    {
      threshold,
    },
  );
  return {
    width,
    height,
    mismatched,
    percent: (mismatched / (width * height)) * 100,
    sizeMatches: imgA.width === imgB.width && imgA.height === imgB.height,
    diff: PNG.sync.write(out),
  };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      threshold: { type: 'string', default: '0.1' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length !== 2) {
    console.log('Usage: pnpm visual:diff <a.png> <b.png> [--out diff.png] [--threshold 0.1]');
    process.exit(values.help ? 0 : 1);
  }
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const [a, b] = positionals.map((p) => resolve(cwd, p)) as [string, string];
  const result = diffPng(await readFile(a), await readFile(b), Number(values.threshold));
  if (values.out) await writeFile(resolve(cwd, values.out), result.diff);
  if (!result.sizeMatches) console.log(`size differs (compared at ${result.width}×${result.height})`);
  console.log(
    `mismatch ${result.percent.toFixed(2)}% (${result.mismatched} of ${result.width * result.height} px)` +
      (values.out ? ` → ${values.out}` : ''),
  );
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
