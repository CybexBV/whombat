import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  base256,
  checksum,
  fileData,
  malformedTarCases,
  paxBody,
  rawEntry,
  rawHeader,
  rawTar,
} from '../../../../packages/node-io/src/tar/testing/corpus';
import { extractTarStream, headerBlocks, UnsafeArchiveError } from './tar';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wb-tar-parsing-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function chunks(bytes: Buffer): Readable {
  return Readable.from(
    (function* () {
      for (let i = 0; i < bytes.length; i += 137) yield bytes.subarray(i, i + 137);
    })(),
  );
}

describe('release archive parsing policies', () => {
  it('extracts a size field with leading Latin1 NBSP padding', async () => {
    const bytes = rawTar([rawEntry({ data: Buffer.from('ok') })]);
    bytes[124] = 0xa0;
    checksum(bytes.subarray(0, 512));

    await expect(extractTarStream(chunks(bytes), root)).resolves.toMatchObject([{ path: 'file', size: 2 }]);
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('ok');
  });

  it('keeps exact diagnostics for binary sizes and high-bit bytes that are not padding', async () => {
    for (const field of [
      base256(2n),
      Buffer.alloc(12, 0xff),
      Buffer.from('\xa10000000002\0', 'latin1'),
      Buffer.from('2\0garbage'),
    ]) {
      const bytes = rawTar([rawEntry({ data: fileData, fields: [{ offset: 124, width: 12, data: field }] })]);
      await expect(extractTarStream(chunks(bytes), root)).rejects.toThrow(
        new UnsafeArchiveError('corrupt archive (the size field isn’t a number)'),
      );
    }
  });

  for (const sample of malformedTarCases) {
    it(sample.name, async () => {
      const dest = join(root, 'out');
      const extracting = extractTarStream(chunks(sample.bytes()), dest);
      if (sample.releaseError) {
        await expect(extracting).rejects.toThrow(UnsafeArchiveError);
        await expect(extracting).rejects.toThrow(sample.releaseError);
      } else {
        await expect(extracting).resolves.toMatchObject([{ path: 'file', size: fileData.length }]);
        expect(readFileSync(join(dest, 'file'))).toEqual(fileData);
      }
    });
  }

  it('uses byte-counted UTF-8 PAX paths and sizes across chunks, then clears the local metadata', async () => {
    const data = Buffer.alloc(513, 0x61);
    const path = 'd/é.md';
    const bytes = rawTar([
      rawEntry({
        type: 'x',
        data: paxBody([
          ['path', path],
          ['size', String(data.length)],
        ]),
      }),
      rawEntry({ name: 'fallback', size: 0, data }),
      rawEntry({ name: 'next', data: fileData }),
    ]);
    const entries = await extractTarStream(chunks(bytes), root);
    expect(entries.map((entry) => [entry.path, entry.size])).toEqual([
      [path, 513],
      ['next', 2],
    ]);
    expect(readFileSync(join(root, path))).toEqual(data);
    expect(readFileSync(join(root, 'next'))).toEqual(fileData);
    expect(statSync(join(root, path)).mode & 0o777).toBe(0o644);
  });

  it('uses a prefix even without ustar magic, and validates global PAX without applying it', async () => {
    const bytes = rawTar([
      rawEntry({
        type: 'g',
        data: paxBody([
          ['path', '../outside'],
          ['size', '99999'],
        ]),
      }),
      rawEntry({ prefix: 'dir', data: fileData, fields: [{ offset: 257, width: 8, data: Buffer.alloc(0) }] }),
    ]);
    await expect(extractTarStream(chunks(bytes), root)).resolves.toMatchObject([
      { path: 'dir/file', size: 2 },
    ]);
    expect(readFileSync(join(root, 'dir/file'))).toEqual(fileData);
  });

  it('enforces the total byte cap before opening a file, including a PAX size override', async () => {
    const bytes = rawTar([
      rawEntry({ type: 'x', data: paxBody([['size', '1025']]) }),
      rawEntry({ name: 'large', size: 0 }),
    ]);
    await expect(extractTarStream(chunks(bytes), root, { maxBytes: 1024 })).rejects.toThrow(
      /more than 1024 bytes/,
    );
    expect(existsSync(join(root, 'large'))).toBe(false);
  });

  it('refuses oversized PAX before buffering its body and refuses GNU long-name entries', async () => {
    await expect(
      extractTarStream(chunks(rawHeader({ type: 'x', size: 1024 * 1024 + 1 })), root),
    ).rejects.toThrow(/pax header is too big/);
    await expect(
      extractTarStream(chunks(rawTar([rawEntry({ type: 'L', data: Buffer.from('file\0') })])), root),
    ).rejects.toThrow(/unsupported entry/);
  });

  it('keeps deterministic release header bytes, including long Unicode paths, large sizes and links', () => {
    const cases = [
      {
        entry: { path: 'top/file', type: 'file' as const, mode: 0o6755, size: 513, mtime: 1700000000 },
        sha256: '1cf6f93afef72ad7d7e04e9acce90842c2ed063dcc5027032250a84b29101b32',
      },
      {
        entry: {
          path: `top/é/${'long/'.repeat(25)}file`,
          type: 'file' as const,
          mode: 0o644,
          size: 0o77777777777 + 1,
          mtime: 1700000000,
        },
        sha256: '6a3aa21b909e211d212415fa26e15f9d58c57ed8c6b540f85a424491f5776ad0',
      },
      {
        entry: {
          path: 'top/link',
          type: 'symlink' as const,
          mode: 0o777,
          size: 0,
          mtime: 1700000000,
          linkname: `${'é/'.repeat(60)}lib.so`,
        },
        sha256: '9df816dfca94761a9f0eb682cd09fdc6c9c31563e239c1a367a2960bc169f6ed',
      },
    ];
    for (const { entry, sha256 } of cases) {
      // Captured from the pre-extraction writer at 70c4d22e, under Node 24.
      expect(
        createHash('sha256')
          .update(Buffer.concat(headerBlocks(entry)))
          .digest('hex'),
      ).toBe(sha256);
    }
  });
});
