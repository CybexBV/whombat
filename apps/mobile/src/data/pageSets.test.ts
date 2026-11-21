import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PageSetReader, type PagesHostMessage } from '@whombat/client/pages';
import type { ApplianceSession, ResourceRef, ResourceStream } from '@whombat/client/session';
import { PAGES_MANIFEST, zipEnd, zipEntries, zipStored } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  entryDataAt,
  externalHost,
  externalLine,
  LOCAL_HEADER_BYTES,
  openedPage,
  openingPage,
  pageBefore,
  pageFileLine,
  pageSetMeta,
  pageSubtitle,
  pagesInjection,
  pagesLoaderHtml,
  sessionReadRange,
  sharedCopyPath,
} from './pageSets';
import { HTML_PREVIEW_CSP } from './richPreview';

const require = createRequire(import.meta.url);
const RUNTIME = readFileSync(require.resolve('@whombat/client/pages/pages-runtime.js'), 'utf8');
const text = (s: string) => new TextEncoder().encode(s);

/** A set's file as one buffer. */
function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const parts = zipStored(
    Object.entries(files).map(([path, v]) => ({ path, bytes: typeof v === 'string' ? text(v) : v })),
  );
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** A session that serves `bytes` by range; `skew` changes how many bytes it sends past the range's end. */
function sessionOver(bytes: Uint8Array, skew = 0) {
  const ranges: { start: number; end?: number }[] = [];
  const session = {
    async openResource(_ref: ResourceRef, o: { range?: { start: number; end?: number } } = {}) {
      const start = o.range?.start ?? 0;
      const end = Math.max(start, Math.min(bytes.byteLength, (o.range?.end ?? bytes.byteLength) + skew));
      ranges.push({ start, end: o.range?.end });
      async function* chunks() {
        for (let at = start; at < end; at += 700) yield bytes.slice(at, Math.min(at + 700, end));
      }
      return {
        meta: {
          contentType: 'application/vnd.whombat.pages+zip',
          size: end - start,
          name: null,
          sha256: null,
        },
        chunks: chunks(),
        cancel: () => {},
        summary: () => null,
      } satisfies ResourceStream;
    },
  } as unknown as ApplianceSession;
  return { session, ranges };
}

const REF: ResourceRef = { kind: 'attachment', burrow: 'acme', attachmentId: 'att_pages001' };

describe('a page set on the phone', () => {
  it('loads every page under the page policy, first, with the viewer’s script as a data URL', () => {
    const html = pagesLoaderHtml();
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
    expect(policy?.[1]).toBe(HTML_PREVIEW_CSP);
    // Nothing comes before the policy but the doctype.
    expect(html.slice(0, policy?.index).toLowerCase()).toBe('<!doctype html>');
    expect(html).toContain('name="viewport"');
    const src = /<script src="data:application\/javascript;base64,([^"]+)"><\/script>/.exec(html)?.[1];
    expect(Buffer.from(src ?? '', 'base64').toString('utf8')).toBe(RUNTIME);
  });

  it('hands the frame a message that no path or name can break out of', () => {
    const sep = String.fromCharCode(0x2028, 0x2029);
    const message: PagesHostMessage = {
      type: 'whombat.pages.show',
      path: `a"b\\c'</script>${sep}.html`,
      hash: '#x");alert(1);("',
    };
    const script = pagesInjection(message);
    expect(script).not.toContain(String.fromCharCode(0x2028));
    expect(script).not.toContain(String.fromCharCode(0x2029));
    expect(script.endsWith('true;')).toBe(true);
    const got: unknown[] = [];
    new Function('window', script)({ __whombatPages: (m: unknown) => got.push(m) });
    expect(got).toHaveLength(1);
    expect(typeof got[0]).toBe('string');
    expect(JSON.parse(got[0] as string)).toEqual(message);
    // Before the viewer's script has started there is nothing to call, and nothing breaks.
    expect(() => new Function('window', script)({})).not.toThrow();
  });

  it('says where a link out goes, and only for http(s)', () => {
    expect(externalHost('https://example.com/a?b#c')).toBe('example.com');
    expect(externalHost('http://Example.COM:8080')).toBe('example.com:8080');
    expect(externalHost('https://bank.com@evil.example/login')).toBe('evil.example');
    expect(externalHost('javascript:alert(1)')).toBeNull();
    expect(externalHost('mailto:a@b.c')).toBeNull();
    expect(externalHost('https:///nothing')).toBeNull();
    expect(externalLine('example.com')).toContain('example.com');
  });

  it('names the set’s size and a file’s name and size', () => {
    expect(pageSetMeta({ size: 30 * 1024 * 1024 })).toBe('Pages · 30 MB');
    const line = pageFileLine('round-2/docs/report.pdf', 2.4 * 1024 * 1024);
    expect(line).toContain('report.pdf');
    expect(line).toContain('2.4 MB');
    expect(line).not.toContain('round-2');
  });

  it('opens on the page the set names, else index.html', () => {
    expect(openingPage({ open: 'round-2/index.html' })).toBe('round-2/index.html');
    expect(openingPage(null)).toBe('index.html');
  });

  it('goes back through the pages you opened; a page that sends you on takes its place', () => {
    const a = { path: 'index.html', hash: '' };
    const b = { path: 'about.html', hash: '#team' };
    const c = { path: 'docs/index.html', hash: '' };
    const opened = openedPage(openedPage([a], b, false), c, true);
    expect(opened).toEqual([a, c]);
    expect(pageBefore(opened)).toEqual([a]);
    expect(pageBefore([a])).toBeNull();
  });

  it('shows a page’s own title only when it adds something', () => {
    expect(pageSubtitle('Council mockups', 'Round 2  · options')).toBe('Round 2 · options');
    expect(pageSubtitle('Council mockups', 'Council mockups')).toBeNull();
    expect(pageSubtitle('Council mockups', '  ')).toBeNull();
  });

  it('copies a file to share under its own name in the shared cache', () => {
    expect(sharedCopyPath('att_pages001', 'docs/Q3 report.pdf')).toEqual({
      dir: ['shared', 'att_pages001'],
      name: 'Q3 report.pdf',
    });
    expect(sharedCopyPath('att_pages001', 'files/.env').name).toBe('env');
  });
});

describe('reading a page set through the session', () => {
  const files = {
    [PAGES_MANIFEST]: JSON.stringify({
      v: 1,
      title: 'Council mockups',
      open: 'round-2/index.html',
      files: 2,
      pages: 1,
      cover: false,
    }),
    'round-2/index.html': '<!doctype html><title>Round 2</title><img src="a.png">',
    'round-2/a.png': new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  };

  it('reads the directory, then each file by its own range', async () => {
    const bytes = zip(files);
    const { session, ranges } = sessionOver(bytes);
    const reader = new PageSetReader(sessionReadRange(session, REF), bytes.byteLength);
    expect((await reader.manifest())?.open).toBe('round-2/index.html');
    expect(await reader.file('round-2/a.png')).toEqual(files['round-2/a.png']);
    // The set was never read whole: the tail first, then one range per file.
    expect(ranges[0]?.end).toBe(bytes.byteLength);
    expect(ranges.every((r) => r.end !== undefined)).toBe(true);
  });

  it('refuses a read that comes back short or longer than its range', async () => {
    const bytes = zip(files);
    for (const skew of [-3, 5]) {
      const { session } = sessionOver(bytes, skew);
      const read = sessionReadRange(session, REF);
      await expect(read({ start: 10, end: 60 })).rejects.toThrow();
    }
    const { session } = sessionOver(bytes);
    expect(await sessionReadRange(session, REF)({ start: 10, end: 60 })).toEqual(bytes.slice(10, 60));
  });

  it('finds where a file’s bytes start from its local header alone', () => {
    const bytes = zip(files);
    const end = zipEnd(bytes, bytes.byteLength);
    if (!end) throw new Error('no end record');
    const entries = zipEntries(
      bytes.subarray(end.directoryOffset, end.directoryOffset + end.directorySize),
      end,
    );
    if (!Array.isArray(entries)) throw new Error(entries.error);
    const png = entries.find((e) => e.path === 'round-2/a.png');
    if (!png) throw new Error('no picture');
    const at = entryDataAt(png, bytes.subarray(png.offset, png.offset + LOCAL_HEADER_BYTES));
    expect(at).not.toBeNull();
    expect(bytes.slice(at ?? 0, (at ?? 0) + png.size)).toEqual(files['round-2/a.png']);
    // Anywhere else isn't an entry's header.
    expect(entryDataAt(png, bytes.subarray(png.offset + 1, png.offset + 1 + LOCAL_HEADER_BYTES))).toBeNull();
    expect(entryDataAt(png, bytes.subarray(0, 10))).toBeNull();
  });
});
