import { describe, expect, it } from 'vitest';
import {
  cleanPagePath,
  crc32,
  isPageSet,
  PAGES_CONTENT_TYPE,
  pageFileFor,
  pageSetFileName,
  pageSetTitle,
  resolvePageRef,
  zipEnd,
  zipEntries,
  zipEntryData,
  zipEntryRange,
  zipStored,
} from './pages.js';
import { encodeUtf8 } from './utf8.js';

const text = encodeUtf8;
const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe('page paths', () => {
  it('keeps clean paths and folds dots', () => {
    expect(cleanPagePath('index.html')).toBe('index.html');
    expect(cleanPagePath('a/./b/../c.html')).toBe('a/c.html');
    expect(cleanPagePath('a//b')).toBe('a/b');
  });

  it('refuses paths that leave the folder or aren’t paths', () => {
    for (const p of ['', '.', '../x', 'a/../../x', 'a\\b', 'a\u0000b'])
      expect(cleanPagePath(p), p).toBeNull();
  });

  it('resolves a link from the page it is on', () => {
    expect(resolvePageRef('round-2/index.html', '../style.css')).toEqual({
      kind: 'file',
      path: 'style.css',
      hash: '',
    });
    expect(resolvePageRef('round-2/index.html', 'shots/a%20b.png?v=2#top')).toEqual({
      kind: 'file',
      path: 'round-2/shots/a b.png',
      hash: '#top',
    });
    expect(resolvePageRef('a/b.html', '/c.html')).toEqual({ kind: 'file', path: 'c.html', hash: '' });
  });

  it('reads a folder as its index page', () => {
    expect(resolvePageRef('index.html', 'round-2/')).toMatchObject({ path: 'round-2/index.html' });
    expect(resolvePageRef('round-2/x.html', '.')).toMatchObject({ path: 'round-2/index.html' });
    expect(resolvePageRef('round-2/x.html', '..')).toMatchObject({ path: 'index.html' });
    expect(resolvePageRef('a.html', '/')).toMatchObject({ path: 'index.html' });
  });

  it('leaves other places and anchors alone', () => {
    for (const ref of [
      'https://example.com/x',
      '//cdn.example.com/a.js',
      'data:image/png;base64,AA',
      'mailto:a@b',
    ])
      expect(resolvePageRef('index.html', ref), ref).toEqual({ kind: 'outside' });
    expect(resolvePageRef('index.html', '../../etc/passwd')).toEqual({ kind: 'outside' });
    expect(resolvePageRef('index.html', '#notes')).toEqual({ kind: 'same', hash: '#notes' });
  });

  it('finds the file a link opens like a static site', () => {
    const files = new Set(['about.html', 'docs/index.html']);
    const has = (p: string) => files.has(p);
    expect(pageFileFor(has, 'about')).toBe('about.html');
    expect(pageFileFor(has, 'docs')).toBe('docs/index.html');
    expect(pageFileFor(has, 'gone')).toBeNull();
  });
});

describe('page set names', () => {
  it('knows a set by its type and names it after its title', () => {
    expect(isPageSet({ contentType: PAGES_CONTENT_TYPE })).toBe(true);
    expect(isPageSet({ contentType: 'application/zip' })).toBe(false);
    expect(pageSetFileName('Council mockups: round 2/3')).toBe('Council mockups round 2 3.zip');
    expect(pageSetTitle('Council mockups.zip')).toBe('Council mockups');
  });
});

describe('the stored ZIP', () => {
  const files = [
    { path: 'index.html', bytes: text('<a href="round-2/">Round 2</a>') },
    { path: 'round-2/index.html', bytes: text('<img src="shot.png">') },
    { path: 'round-2/shot.png', bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) },
    { path: 'ünïcode.txt', bytes: text('hé') },
  ];
  const zip = join(zipStored(files, new Date('2026-11-06T15:33:00Z')));

  it('has the CRC-32 every ZIP tool checks', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
  });

  it('reads back every file by its range', () => {
    const end = zipEnd(zip.subarray(zip.length - 1024 < 0 ? 0 : zip.length - 1024), zip.length);
    expect(end).not.toBeNull();
    if (!end) return;
    const entries = zipEntries(
      zip.subarray(end.directoryOffset, end.directoryOffset + end.directorySize),
      end,
    );
    expect(Array.isArray(entries)).toBe(true);
    if (!Array.isArray(entries)) return;
    expect(entries.map((e) => e.path)).toEqual(files.map((f) => f.path));
    for (const [i, entry] of entries.entries()) {
      const range = zipEntryRange(entry);
      const data = zipEntryData(entry, zip.subarray(range.start, range.end));
      expect(data).toEqual(files[i]?.bytes);
      expect(entry.crc).toBe(crc32(files[i]?.bytes ?? new Uint8Array()));
    }
  });

  it('refuses a directory with a path outside the folder', () => {
    const bad = join(zipStored([{ path: '../evil.html', bytes: text('x') }]));
    const end = zipEnd(bad, bad.length);
    if (!end) throw new Error('no end');
    const entries = zipEntries(
      bad.subarray(end.directoryOffset, end.directoryOffset + end.directorySize),
      end,
    );
    expect(entries).toMatchObject({ error: expect.stringContaining('evil') });
  });

  it('finds no end in something that isn’t a ZIP', () => {
    expect(zipEnd(text('not a zip at all, just words'), 28)).toBeNull();
  });
});
