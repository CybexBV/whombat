/**
 * Pre-compressed siblings of the hashed assets (docs/decisions/web-efficiency.md WE-03): every compressible file under
 * `assets/` of a self-hosted build gets `<file>.br` (brotli, quality 11) and `<file>.gz` (gzip, level 9) next to it
 * when that saves at least a tenth. The runtime's static server sends one by `Accept-Encoding` (Whombat SV-13) instead
 * of the raw file. Same input, same bytes: `release:dist` stays deterministic.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { Plugin } from 'vite';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** Text formats worth compressing (fonts and images are compressed already). */
export const COMPRESSIBLE = /\.(?:js|mjs|css|svg|json|html|txt|wasm|xml)$/i;
/** Below this a compressed copy saves less than a packet. */
export const MIN_BYTES = 1024;

/** Whether `fileName` (relative to the build's root) gets compressed siblings. */
export function compressible(fileName: string, bytes: number): boolean {
  return fileName.startsWith('assets/') && COMPRESSIBLE.test(fileName) && bytes >= MIN_BYTES;
}

/** The `.br` and `.gz` copies of `data` that are worth keeping (each at most 90 % of the original). */
export async function compressedSiblings(
  fileName: string,
  data: Uint8Array,
): Promise<{ fileName: string; data: Uint8Array }[]> {
  const [br, gzipped] = await Promise.all([
    brotli(data, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength,
      },
    }),
    gz(data, { level: 9 }),
  ]);
  return [
    { fileName: `${fileName}.br`, data: br },
    { fileName: `${fileName}.gz`, data: gzipped },
  ].filter((c) => c.data.byteLength <= data.byteLength * 0.9);
}

export function precompress(): Plugin {
  return {
    name: 'whombat-precompress',
    apply: 'build',
    async writeBundle(options, bundle) {
      const dir = options.dir;
      if (!dir) return;
      await Promise.all(
        Object.keys(bundle).map(async (fileName) => {
          const path = join(dir, fileName);
          const data = await readFile(path);
          if (!compressible(fileName, data.byteLength)) return;
          for (const sibling of await compressedSiblings(fileName, data))
            await writeFile(join(dir, sibling.fileName), sibling.data);
        }),
      );
    },
  };
}
