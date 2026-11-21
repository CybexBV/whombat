import { describe, expect, it } from 'vitest';
import {
  paddedTarSize,
  padTarBuffer,
  parsePaxRecords,
  parsePaxSize,
  parseTarNumber,
  tarChecksum,
  tarPadding,
  tarPath,
  tarString,
  writePaxRecord,
  writeUstarHeader,
} from './index';
import { base256, paxBody, rawHeader } from './testing/corpus';

const error = () => new Error('invalid tar field');
const strict = { format: 'strict' as const, error };
const client = {
  format: 'compatible' as const,
  length: 'decimal-prefix' as const,
  minimumLength: 'prefix' as const,
  invalidLength: 'throw' as const,
  error,
};
const pack = {
  format: 'compatible' as const,
  length: 'number' as const,
  minimumLength: 'positive' as const,
  invalidLength: 'stop' as const,
  error,
};

describe('tar field primitives', () => {
  it('reads bounded strings and conditionally applies a header prefix', () => {
    const header = rawHeader({ name: 'é.md', prefix: 'dir' });
    expect(tarString(header, 0, 100)).toBe('é.md');
    expect(tarString(Buffer.from('abc'), 1, 2)).toBe('bc');
    expect(tarString(Buffer.from('a\0junk'))).toBe('a');
    expect(tarPath(header, true)).toBe('dir/é.md');
    expect(tarPath(header, false)).toBe('é.md');
  });

  it('distinguishes NUL termination from full-field padding validation', () => {
    for (const termination of ['nul', 'padding'] as const) {
      expect(parseTarNumber(Buffer.from(' 0000755\0 '), { base256: 'reject', termination, error })).toBe(
        0o755,
      );
      expect(parseTarNumber(Buffer.from(' \0 '), { base256: 'reject', termination, error })).toBe(0);
      for (const value of ['-1', '888', '1.5', '1e3'])
        expect(() => parseTarNumber(Buffer.from(value), { base256: 'reject', termination, error })).toThrow(
          /invalid/,
        );
    }
    const field = Buffer.from('2\0garbage');
    expect(parseTarNumber(field, { base256: 'reject', termination: 'nul', error })).toBe(2);
    expect(() => parseTarNumber(field, { base256: 'reject', termination: 'padding', error })).toThrow(
      /invalid/,
    );
  });

  it('allows base-256 only when requested and refuses unsafe or negative values', () => {
    const options = { base256: 'allow' as const, termination: 'nul' as const, error };
    expect(parseTarNumber(base256(513n), options)).toBe(513);
    expect(parseTarNumber(base256(9007199254740991n), options)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseTarNumber(base256(1n), { ...options, base256: 'reject' })).toThrow(/invalid/);
    expect(() => parseTarNumber(base256(9007199254740992n), options)).toThrow(/invalid/);
    expect(() => parseTarNumber(Buffer.alloc(12, 0xff), options)).toThrow(/invalid/);
    expect(() => parseTarNumber(Buffer.from([0xff]), options)).toThrow(/invalid/);
    expect(() => parseTarNumber(Buffer.from('777777777777777777777777'), options)).toThrow(/invalid/);
  });

  it('keeps Latin1 octal padding distinct from GNU high-bit policies', () => {
    const samples = [
      { field: Buffer.from('\xa00000000002\0', 'latin1'), octal: 2, allow: 'range' },
      { field: base256(2n), octal: 'syntax', allow: 2 },
      { field: Buffer.alloc(12, 0xff), octal: 'syntax', allow: 'range' },
      { field: Buffer.from('\xa10000000002\0', 'latin1'), octal: 'syntax', allow: 'range' },
    ];
    for (const sample of samples) {
      for (const base of ['octal-only', 'allow', 'reject'] as const) {
        const expected = base === 'octal-only' ? sample.octal : base === 'allow' ? sample.allow : 'base256';
        const parse = () =>
          parseTarNumber(sample.field, {
            base256: base,
            termination: base === 'octal-only' ? 'padding' : 'nul',
            error: (problem) => new Error(problem),
          });
        if (typeof expected === 'number') expect(parse()).toBe(expected);
        else expect(parse).toThrow(new Error(expected));
      }
    }
  });

  it('parses whole, safe decimal PAX sizes and optional digit caps', () => {
    expect(parsePaxSize('0002', error)).toBe(2);
    expect(parsePaxSize(String(Number.MAX_SAFE_INTEGER), error)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parsePaxSize('0000000000000002', error, 15)).toThrow(/invalid/);
    for (const value of ['', '-1', '1.5', '1e3', '9007199254740992', ' 1'])
      expect(() => parsePaxSize(value, error)).toThrow(/invalid/);
  });

  it('writes the same ustar bytes as an independent fixture and ignores stored checksum bytes when summing', () => {
    const expected = rawHeader({ name: 'é.md', prefix: 'dir', size: 513, type: '0' });
    const header = writeUstarHeader({
      name: 'é.md',
      prefix: 'dir',
      mode: 0o644,
      size: 513,
      mtime: 0,
      typeflag: '0',
    });
    expect(header).toEqual(expected);
    const stored = Number.parseInt(tarString(header, 148, 8).trim(), 8);
    expect(tarChecksum(header)).toBe(stored);
    header.fill(0xff, 148, 156);
    expect(tarChecksum(header)).toBe(stored);
  });

  it('pads only incomplete blocks, without changing data bytes', () => {
    for (const size of [0, 1, 511, 512, 513, 1024]) {
      const data = Buffer.alloc(size, 0x61);
      const padded = padTarBuffer(data);
      expect(padded.length).toBe(Math.ceil(size / 512) * 512);
      expect(paddedTarSize(size)).toBe(padded.length);
      expect(tarPadding(size)).toBe(padded.length - size);
      expect(padded.subarray(0, size)).toEqual(data);
      expect(padded.subarray(size).every((byte) => byte === 0)).toBe(true);
    }
  });
});

describe('PAX framing policies', () => {
  it('counts UTF-8 bytes, including when the length gains a decimal digit', () => {
    for (const size of [0, 1, 8, 9, 88, 89, 98, 99, 998]) {
      const value = `${'é'.repeat(size)}=value`;
      const record = writePaxRecord('path', value);
      expect(record).toEqual(paxBody([['path', value]]));
      expect(Number(record.subarray(0, record.indexOf(0x20)).toString())).toBe(record.length);
      expect(parsePaxRecords(record, strict).get('path')).toBe(value);
    }
  });

  it('keeps the last duplicate and tolerates trailing NUL padding', () => {
    const body = Buffer.concat([
      paxBody([
        ['path', 'old'],
        ['path', 'new'],
      ]),
      Buffer.alloc(20),
    ]);
    for (const options of [strict, client, pack])
      expect([...parsePaxRecords(body, options)]).toEqual([['path', 'new']]);
  });

  it('keeps strict errors separate from the selected-entry and in-memory compatibility rules', () => {
    const cases = [
      { text: '13 path=file!', client: [['path', 'file']], pack: [['path', 'file']] },
      { text: '14x path=file\n', client: [['path', 'file']], pack: [] },
      { text: '13 no-equals!\n', client: [], pack: [] },
      { text: 'garbage', client: [], pack: [] },
    ];
    for (const sample of cases) {
      const bytes = Buffer.from(sample.text);
      expect(() => parsePaxRecords(bytes, strict)).toThrow(/invalid/);
      expect([...parsePaxRecords(bytes, client)]).toEqual(sample.client);
      expect([...parsePaxRecords(bytes, pack)]).toEqual(sample.pack);
    }
    for (const text of [
      '0 path=file\n',
      '-1 path=file\n',
      '99 path=file\n',
      'x path=file\n',
      '9007199254740993 path=file\n',
    ]) {
      const bytes = Buffer.from(text);
      expect(() => parsePaxRecords(bytes, strict)).toThrow(/invalid/);
      expect(() => parsePaxRecords(bytes, client)).toThrow(/invalid/);
      expect([...parsePaxRecords(bytes, pack)]).toEqual([]);
    }
  });
});
