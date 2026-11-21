import { utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { BackupFileError } from './errors.js';
import {
  isSafeTarPath,
  TAR_BLOCK_BYTES,
  TAR_ENTRY_MAX_BYTES,
  type TarEntry,
  TarReader,
  TarWriter,
  tarEnd,
  tarFile,
  tarHeader,
  tarPadding,
} from './tar.js';

const enc = (s: string) => utf8ToBytes(s);
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Reads an archive pushed in pieces; returns each entry with its bytes. */
function readAll(archive: Uint8Array, piece = 97): { entry: TarEntry; data: Uint8Array }[] {
  const reader = new TarReader();
  const files: { entry: TarEntry; data: Uint8Array }[] = [];
  let parts: Uint8Array[] = [];
  for (let i = 0; i < archive.length; i += piece) {
    for (const ev of reader.push(archive.subarray(i, i + piece))) {
      if (ev.type === 'entry') parts = [];
      else if (ev.type === 'data') parts.push(ev.data.slice());
      else files.push({ entry: ev.entry, data: concat(parts) });
    }
  }
  reader.finish();
  return files;
}

const damaged = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof BackupFileError ? e.code : String(e);
  }
  return 'ok';
};

describe('backup tar (CT-335)', () => {
  it('writes POSIX ustar headers', () => {
    const h = tarHeader({ name: 'manifest.json', size: 1234, mtime: 1_790_000_000 });
    expect(h.length).toBe(TAR_BLOCK_BYTES);
    const text = String.fromCharCode(...h);
    expect(text.slice(0, 13)).toBe('manifest.json');
    expect(text.slice(100, 107)).toBe('0000644');
    expect(text.slice(124, 135)).toBe((1234).toString(8).padStart(11, '0'));
    expect(text.slice(257, 263)).toBe('ustar\0');
    expect(text.slice(263, 265)).toBe('00');
    expect(h[156]).toBe(0x30);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
    expect(Number.parseInt(text.slice(148, 154), 8)).toBe(sum);
  });

  it('round-trips entries of every size around the block boundary, pushed in any pieces', () => {
    const w = new TarWriter();
    const sizes = [0, 1, 511, 512, 513, 1024, 3000];
    const parts: Uint8Array[] = [];
    for (const n of sizes) {
      const data = new Uint8Array(n).map((_, i) => (i * 7 + n) & 0xff);
      parts.push(w.begin({ name: `files/${'a'.repeat(63)}${n % 10}x${n}`, size: n, mtime: 5 }));
      parts.push(w.write(data.subarray(0, Math.floor(n / 2))), w.write(data.subarray(Math.floor(n / 2))));
      parts.push(w.end());
    }
    parts.push(w.file('manifest.json', enc('{}')));
    parts.push(w.finish());
    const archive = concat(parts);
    expect(archive.length % 512).toBe(0);
    for (const piece of [1, 7, 512, 4096]) {
      const files = readAll(archive, piece);
      expect(files.map((f) => f.entry.size)).toEqual([...sizes, 2]);
      for (const [i, n] of sizes.entries())
        expect(files[i]?.data).toEqual(new Uint8Array(n).map((_, j) => (j * 7 + n) & 0xff));
      expect(files[sizes.length]?.entry.name).toBe('manifest.json');
      expect(files[0]?.entry.mtime).toBe(5);
    }
  });

  it('splits long paths into prefix and name, up to 255 bytes', () => {
    const long = `repositories/${'d'.repeat(120)}/${'n'.repeat(90)}.bundle`;
    const archive = concat([tarFile(long, enc('x')), tarEnd()]);
    expect(readAll(archive)[0]?.entry.name).toBe(long);
    expect(() => tarHeader({ name: `${'x'.repeat(150)}`, size: 0, mtime: 0 })).toThrow();
    expect(() => tarHeader({ name: `a/${'x'.repeat(260)}`, size: 0, mtime: 0 })).toThrow();
  });

  it('refuses unsafe paths when writing and reading', () => {
    for (const bad of [
      '',
      '/etc/passwd',
      '../x',
      'a/../b',
      'a//b',
      'a/./b',
      'a\\b',
      'a/',
      'x\u0000y',
      'x\ny',
    ])
      expect(isSafeTarPath(bad), JSON.stringify(bad)).toBe(false);
    expect(isSafeTarPath('files/abc')).toBe(true);
    expect(() => tarHeader({ name: '../evil', size: 0, mtime: 0 })).toThrow();
    // A header written by hand with `..` in its name.
    const h = tarHeader({ name: 'aa/evil', size: 0, mtime: 0 });
    h.set(enc('..'), 0);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
    h.set(enc(sum.toString(8).padStart(6, '0')), 148);
    expect(damaged(() => readAll(concat([h, tarEnd()])))).toBe('damaged');
  });

  it('refuses a bad checksum, another type, non-ustar, bytes after the end and a short archive', () => {
    const good = concat([tarFile('a.jsonl', enc('hello')), tarEnd()]);
    expect(readAll(good)).toHaveLength(1);
    const flip = (at: number, v?: number) => {
      const a = good.slice();
      a[at] = v ?? (a[at] as number) ^ 1;
      return a;
    };
    expect(damaged(() => readAll(flip(3)))).toBe('damaged'); // name byte: checksum
    expect(damaged(() => readAll(flip(600)))).toBe('damaged'); // padding not zero
    const sym = tarHeader({ name: 'link', size: 0, mtime: 0 });
    sym[156] = 0x32; // symlink
    sym.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of sym) sum += b;
    sym.set(enc(sum.toString(8).padStart(6, '0')), 148);
    sym[154] = 0;
    expect(damaged(() => readAll(concat([sym, tarEnd()])))).toBe('damaged');
    expect(damaged(() => readAll(good.subarray(0, good.length - 512)))).toBe('damaged');
    expect(damaged(() => readAll(concat([good, tarFile('b', enc('x'))])))).toBe('damaged');
    expect(readAll(concat([good, new Uint8Array(1024)]))).toHaveLength(1); // trailing zero blocks are fine
  });

  it('checks the writer’s sizes and bounds', () => {
    const w = new TarWriter();
    w.begin({ name: 'a', size: 3, mtime: 0 });
    expect(() => w.write(new Uint8Array(4))).toThrow();
    const w2 = new TarWriter();
    w2.begin({ name: 'a', size: 3, mtime: 0 });
    w2.write(new Uint8Array(2));
    expect(() => w2.end()).toThrow();
    expect(() => tarHeader({ name: 'a', size: TAR_ENTRY_MAX_BYTES + 1, mtime: 0 })).toThrow();
    expect(tarHeader({ name: 'a', size: TAR_ENTRY_MAX_BYTES, mtime: 0 }).length).toBe(512);
    expect(tarPadding(512).length).toBe(0);
    expect(tarPadding(513).length).toBe(511);
  });
});
