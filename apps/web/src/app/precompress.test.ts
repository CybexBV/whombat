import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { compressedSiblings, compressible } from '../../precompress';

describe('pre-compressed assets (WE-03)', () => {
  it('compresses text files under assets/ from 1 KiB, never fonts, images or the root files', () => {
    expect(compressible('assets/index-abc.js', 4096)).toBe(true);
    expect(compressible('assets/index-abc.css', 4096)).toBe(true);
    expect(compressible('assets/pdf.worker.min-abc.mjs', 4096)).toBe(true);
    expect(compressible('assets/logo-abc.svg', 4096)).toBe(true);
    expect(compressible('assets/index-abc.js', 1023)).toBe(false);
    expect(compressible('assets/font-abc.woff2', 40_000)).toBe(false);
    expect(compressible('assets/icon-abc.png', 40_000)).toBe(false);
    expect(compressible('index.html', 4096)).toBe(false);
    expect(compressible('sw.js', 4096)).toBe(false);
  });

  it('writes .br and .gz that decompress to the original, the same bytes every time', async () => {
    const text = 'export const x = "whombat";\n'.repeat(200);
    const data = Buffer.from(text);
    const first = await compressedSiblings('assets/a.js', data);
    expect(first.map((s) => s.fileName)).toEqual(['assets/a.js.br', 'assets/a.js.gz']);
    expect(brotliDecompressSync(first[0]?.data ?? Buffer.alloc(0)).toString()).toBe(text);
    expect(gunzipSync(first[1]?.data ?? Buffer.alloc(0)).toString()).toBe(text);
    const second = await compressedSiblings('assets/a.js', data);
    expect(second.map((s) => Buffer.from(s.data).toString('hex'))).toEqual(
      first.map((s) => Buffer.from(s.data).toString('hex')),
    );
  });

  it('keeps no sibling that saves less than a tenth', async () => {
    const noise = crypto.getRandomValues(new Uint8Array(4096));
    expect(await compressedSiblings('assets/noise.js', noise)).toEqual([]);
  });
});
