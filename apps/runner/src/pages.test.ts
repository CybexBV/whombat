import {
  PAGES_COVER,
  PAGES_MANIFEST,
  PageSetManifest,
  zipEnd,
  zipEntries,
  zipEntryData,
  zipEntryRange,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { packPages, pageProblems } from './pages';

const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text) });
/** A template's placeholder as a page's script would leave it in an attribute. */
const PLACEHOLDER = ['$', '{url}'].join('');

describe('pageProblems', () => {
  it('names links and files that aren’t in the folder, and what would load from the internet', () => {
    const problems = pageProblems([
      file(
        'index.html',
        '<link rel="stylesheet" href="style.css"><link rel="preconnect" href="https://fonts.gstatic.com"><a href="round-2/">Round 2</a><a href="gone.html">Gone</a><img src="../../apps/web/shot.png"><script src="https://cdn.example.com/x.js"></script><a href="https://example.com">fine</a><a href="#top">top</a><img src="data:image/png;base64,AA">',
      ),
      file(
        'round-2/index.html',
        `<img srcset="a.png 1x, b.png 2x"><script>el.innerHTML = '<img src="x.png">';</script><img src="${PLACEHOLDER}"><img src="{{ src }}">`,
      ),
      file('round-2/a.png', 'png'),
      file('frames.html', '<iframe src="round-2/index.html"></iframe>'),
      file('style.css', '@font-face{src:url(fonts/missing.woff2)}body{background:url("round-2/a.png")}'),
    ]);
    expect(problems.some((p) => p.includes('gone.html') && p.includes('isn’t in the folder'))).toBe(true);
    expect(
      problems.some((p) => p.includes('../../apps/web/shot.png') && p.includes('outside the folder')),
    ).toBe(true);
    expect(problems.some((p) => p.includes('cdn.example.com') && p.includes('internet'))).toBe(true);
    expect(problems.some((p) => p.startsWith('round-2/index.html: b.png'))).toBe(true);
    expect(problems.some((p) => p.startsWith('style.css: fonts/missing.woff2'))).toBe(true);
    // A preconnect hint, a link to the internet, an anchor and inline data are fine.
    expect(problems.some((p) => p.includes('fonts.gstatic.com') || p.includes('example.com"'))).toBe(false);
    expect(problems.some((p) => p.startsWith('frames.html: round-2/index.html is in a frame'))).toBe(true);
    expect(problems).toHaveLength(6);
  });
});

describe('packPages', () => {
  const files = [
    file('index.html', '<a href="b.html">b</a>'),
    file('b.html', 'b'),
    file('.whombat/pages.json', '{}'),
  ];

  it('packs the folder with the cover and the manifest last', () => {
    const packed = packPages(files, { open: 'index', title: 'Mockups' }, 'mockups', Buffer.from('cover'));
    if ('error' in packed) throw new Error(packed.error);
    const zip = Buffer.concat(packed.parts);
    expect(zip.length).toBe(packed.size);
    const end = zipEnd(zip, zip.length);
    if (!end) throw new Error('no end');
    const entries = zipEntries(
      zip.subarray(end.directoryOffset, end.directoryOffset + end.directorySize),
      end,
    );
    if (!Array.isArray(entries)) throw new Error(entries.error);
    // The folder's own .whombat/pages.json is left out: the set's comes last.
    expect(entries.map((e) => e.path)).toEqual(['index.html', 'b.html', PAGES_COVER, PAGES_MANIFEST]);
    const last = entries.at(-1);
    if (!last) throw new Error('no manifest');
    const range = zipEntryRange(last);
    const data = zipEntryData(last, zip.subarray(range.start, range.end));
    const manifest = PageSetManifest.parse(JSON.parse(Buffer.from(data as Uint8Array).toString()));
    expect(manifest).toMatchObject({ title: 'Mockups', open: 'index.html', files: 2, pages: 2, cover: true });
    expect(manifest.problems.some((p) => p.includes('left out'))).toBe(true);
  });

  it('refuses a set without the page it opens on', () => {
    expect(packPages(files, { open: 'start.html', title: 'x' }, 'mockups', null)).toMatchObject({
      error: expect.stringContaining('start.html'),
    });
  });
});
