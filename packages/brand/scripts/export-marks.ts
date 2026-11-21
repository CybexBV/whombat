/**
 * Writes every brand mark as `assets/marks/<name>.svg` (marks.md MK-03) from the geometry in `src/`, and removes files of
 * marks that are gone. `files.test.ts` fails when a committed file is stale.
 *
 *   pnpm --filter @whombat/brand export-marks
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brandMarkSvg } from '../src/files';
import { BRAND_MARKS } from '../src/marks';

const dir = resolve(import.meta.dirname, '../assets/marks');
mkdirSync(dir, { recursive: true });
const keep = new Set(BRAND_MARKS.map((name) => `${name}.svg`));
for (const file of readdirSync(dir)) if (file.endsWith('.svg') && !keep.has(file)) rmSync(join(dir, file));
for (const name of BRAND_MARKS) writeFileSync(join(dir, `${name}.svg`), brandMarkSvg(name));
console.log(`wrote ${BRAND_MARKS.length} marks to assets/marks/`);
