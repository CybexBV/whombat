import { describe, expect, it } from 'vitest';
import { fileViewLines, looksBinary, PR_FILE_LINE_MAX, PrFileView, splitFileLines } from './file-view.js';

const show = (base: string | null, head: string | null) =>
  fileViewLines(base, head).map(
    (l) =>
      `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.old ?? '.'}:${l.new ?? '.'} ${l.text}`,
  );

describe('the file view (CT-241)', () => {
  it('splits lines without their endings', () => {
    expect(splitFileLines('')).toEqual([]);
    expect(splitFileLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitFileLines('a\r\nb')).toEqual(['a', 'b']);
    expect(splitFileLines('a\n\n')).toEqual(['a', '']);
  });

  it('shows an unchanged file as context', () => {
    expect(show('a\nb\n', 'a\nb\n')).toEqual([' 1:1 a', ' 2:2 b']);
  });

  it('numbers an added and a deleted file in their one version', () => {
    expect(show(null, 'a\nb\n')).toEqual(['+.:1 a', '+.:2 b']);
    expect(show('a\nb\n', null)).toEqual(['-1:. a', '-2:. b']);
  });

  it('puts removed lines before the lines that replaced them', () => {
    const base =
      'const net = lineTotal(item)\nconst shown = formatEuro(net * vatRate)\nconst vat = round(shown)\nreturn shown\n';
    const head =
      'const net = lineTotal(item)\nconst vat = roundVat(net * vatRate)\nconst shown = formatAmount(vat, locale)\nreturn shown\n';
    expect(show(base, head)).toEqual([
      ' 1:1 const net = lineTotal(item)',
      '-2:. const shown = formatEuro(net * vatRate)',
      '-3:. const vat = round(shown)',
      '+.:2 const vat = roundVat(net * vatRate)',
      '+.:3 const shown = formatAmount(vat, locale)',
      ' 4:4 return shown',
    ]);
  });

  it('finds the shortest edit in the middle of a file', () => {
    expect(show('a\nb\nc\nd\ne\n', 'a\nx\nc\nd\ny\ne\nf\n')).toEqual([
      ' 1:1 a',
      '-2:. b',
      '+.:2 x',
      ' 3:3 c',
      ' 4:4 d',
      '+.:5 y',
      ' 5:6 e',
      '+.:7 f',
    ]);
  });

  it('keeps every line of both versions, numbered in order', () => {
    const rand = (seed: number) => () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const r = rand(7);
    for (let round = 0; round < 50; round++) {
      const a = Array.from({ length: Math.floor(r() * 40) }, () => String(Math.floor(r() * 6)));
      const b = Array.from({ length: Math.floor(r() * 40) }, () => String(Math.floor(r() * 6)));
      const lines = fileViewLines(a.map((x) => `${x}\n`).join(''), b.map((x) => `${x}\n`).join(''));
      expect(lines.filter((l) => l.kind !== 'add').map((l) => l.text)).toEqual(a);
      expect(lines.filter((l) => l.kind !== 'del').map((l) => l.text)).toEqual(b);
      expect(lines.filter((l) => l.old !== null).map((l) => l.old)).toEqual(a.map((_, i) => i + 1));
      expect(lines.filter((l) => l.new !== null).map((l) => l.new)).toEqual(b.map((_, i) => i + 1));
    }
  });

  it('shows a rewrite beyond the edit budget as removed, then added', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    const lines = fileViewLines(a, b);
    expect(lines).toHaveLength(6000);
    expect(lines[0]).toEqual({ kind: 'del', old: 1, new: null, text: 'a0' });
    expect(lines[3000]).toEqual({ kind: 'add', old: null, new: 1, text: 'b0' });
  });

  it('cuts long lines and parses as a view', () => {
    const [line] = fileViewLines(null, 'x'.repeat(PR_FILE_LINE_MAX + 50));
    expect(line?.text).toHaveLength(PR_FILE_LINE_MAX + 1);
    expect(line?.text.endsWith('…')).toBe(true);
    const view = {
      path: 'a.ts',
      status: 'added',
      shown: 'text',
      add: 1,
      del: 0,
      lines: [line],
      baseSha: null,
      headSha: 'e9f114',
    };
    expect(PrFileView.parse(view)).toEqual(view);
  });

  it('calls bytes with a NUL binary', () => {
    expect(looksBinary(new Uint8Array([0x50, 0x4e, 0x47, 0]))).toBe(true);
    expect(looksBinary(new Uint8Array([0x70, 0x6c, 0x61, 0x69, 0x6e]))).toBe(false);
  });
});
