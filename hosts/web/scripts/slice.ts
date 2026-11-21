// Cut a tall full-page PNG into horizontal slices for side-by-side review.
// Usage: node scripts/slice.ts <input.png> <outDir> [sliceHeight=1150] [x0=0] [width=full]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PNG } from 'pngjs';

const [input, outDir, h = '1150', x0Arg = '0', wArg] = process.argv.slice(2);
if (!input || !outDir) {
  console.error('usage: node scripts/slice.ts <input.png> <outDir> [sliceHeight] [x0] [width]');
  process.exit(2);
}
const src = PNG.sync.read(readFileSync(input));
const sliceH = Number(h);
const x0 = Number(x0Arg);
const width = wArg ? Number(wArg) : src.width - x0;
mkdirSync(outDir, { recursive: true });
const stem = basename(input, '.png');
let n = 0;
for (let y = 0; y < src.height; y += sliceH) {
  const hh = Math.min(sliceH, src.height - y);
  const out = new PNG({ width, height: hh });
  PNG.bitblt(src, out, x0, y, width, hh, 0, 0);
  n++;
  writeFileSync(join(outDir, `${stem}-${n}.png`), PNG.sync.write(out));
}
console.log(`${input}: ${src.width}x${src.height} -> ${n} slices in ${outDir}`);
