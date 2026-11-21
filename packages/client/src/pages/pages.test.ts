import {
  bytesToBase64,
  PAGES_MANIFEST,
  type PageSetManifest,
  ZIP_TAIL_BYTES,
  zipStored,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  base64Of,
  PageSetHost,
  PageSetReader,
  type PagesHostMessage,
  pagesFrameMessage,
  pageTarget,
} from './index';

const text = (s: string) => new TextEncoder().encode(s);
const manifest: PageSetManifest = {
  v: 1,
  title: 'Mockups',
  open: 'index.html',
  files: 3,
  pages: 2,
  cover: false,
  problems: [],
};

function setOf(files: { path: string; bytes: Uint8Array }[]) {
  const parts = zipStored([...files, { path: PAGES_MANIFEST, bytes: text(JSON.stringify(manifest)) }]);
  const zip = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    zip.set(p, at);
    at += p.length;
  }
  const reads: { start: number; end: number }[] = [];
  const reader = new PageSetReader(async (range) => {
    reads.push(range);
    return zip.slice(range.start, range.end);
  }, zip.length);
  return { reader, reads, zip };
}

const files = [
  { path: 'index.html', bytes: text('<a href="about">About</a>') },
  { path: 'about.html', bytes: text('<img src="shot.png">') },
  { path: 'shot.png', bytes: new Uint8Array([137, 80, 78, 71]) },
  { path: 'mockups.zip', bytes: new Uint8Array(40) },
];

describe('PageSetReader', () => {
  it('reads the directory once, then each file by its own range', async () => {
    const { reader, reads } = setOf(files);
    expect(await reader.file('about.html')).toEqual(files[1]?.bytes);
    expect(await reader.file('about.html')).toEqual(files[1]?.bytes);
    expect(await reader.manifest()).toMatchObject({ title: 'Mockups', open: 'index.html' });
    // The tail, about.html once, the manifest.
    expect(reads).toHaveLength(3);
    expect(await reader.file('missing.html')).toBeNull();
  });

  it('reads a directory that starts before the tail', async () => {
    const many = Array.from({ length: 1800 }, (_, i) => ({
      path: `shots/${'x'.repeat(120)}-${i}.png`,
      bytes: new Uint8Array([i % 256]),
    }));
    const { reader, zip } = setOf(many);
    expect(zip.length).toBeGreaterThan(ZIP_TAIL_BYTES);
    expect((await reader.entries()).size).toBe(many.length + 1);
    expect(await reader.file(many[1700]?.path ?? '')).toEqual(many[1700]?.bytes);
  });

  it('says a file that isn’t a set is none', async () => {
    const reader = new PageSetReader(async () => text('nothing to see'), 14);
    await expect(reader.entries()).rejects.toThrow('isn’t a set of pages');
  });
});

describe('pageTarget', () => {
  it('opens pages and pictures, offers other files, knows what is missing', async () => {
    const { reader } = setOf(files);
    expect(await pageTarget(reader, 'about', '#x')).toEqual({ kind: 'page', path: 'about.html', hash: '#x' });
    expect(await pageTarget(reader, 'shot.png')).toMatchObject({ kind: 'page', path: 'shot.png' });
    expect(await pageTarget(reader, 'mockups.zip')).toEqual({ kind: 'file', path: 'mockups.zip', size: 40 });
    expect(await pageTarget(reader, 'gone.html')).toEqual({ kind: 'missing', path: 'gone.html' });
  });
});

describe('PageSetHost', () => {
  it('shows the page when the frame is ready and answers its asks', async () => {
    const { reader } = setOf(files);
    const sent: PagesHostMessage[] = [];
    const host = new PageSetHost(reader, (m) => sent.push(m));
    host.handle({ type: 'whombat.pages.ready' }, { path: 'index.html', hash: '' });
    host.handle({ type: 'whombat.pages.need', id: 1, path: 'shot.png' }, { path: 'index.html', hash: '' });
    host.handle({ type: 'whombat.pages.need', id: 2, path: 'nope.css' }, { path: 'index.html', hash: '' });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent[0]).toEqual({ type: 'whombat.pages.show', path: 'index.html', hash: '', query: '' });
    const shot = sent.find((m) => m.type === 'whombat.pages.file' && m.id === 1);
    expect(shot).toMatchObject({ ok: true, contentType: 'image/png' });
    expect(new Uint8Array((shot as { bytes: ArrayBuffer }).bytes)).toEqual(files[2]?.bytes);
    expect(sent.find((m) => m.type === 'whombat.pages.file' && m.id === 2)).toMatchObject({ ok: false });
  });

  it('sends base64 to the phone’s WebView', async () => {
    const { reader } = setOf(files);
    const sent: PagesHostMessage[] = [];
    const host = new PageSetHost(reader, (m) => sent.push(m), 'base64');
    host.handle('{"type":"whombat.pages.need","id":3,"path":"shot.png"}', { path: 'index.html', hash: '' });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent[0]).toMatchObject({ id: 3, ok: true, base64: 'iVBORw==' });
  });

  it('reads only the viewer’s own messages', () => {
    expect(pagesFrameMessage({ type: 'whombat.pages.external', url: 'javascript:alert(1)' })).toBeNull();
    expect(pagesFrameMessage({ type: 'whombat.pages.need', id: 'x', path: 'a' })).toBeNull();
    expect(pagesFrameMessage('{"type":"other"}')).toBeNull();
    expect(pagesFrameMessage({ type: 'whombat.pages.open', path: 'a.html' })).toEqual({
      type: 'whombat.pages.open',
      path: 'a.html',
      hash: '',
      query: '',
    });
    // A page's `?…` comes along; anything else in its place doesn't.
    expect(
      pagesFrameMessage({ type: 'whombat.pages.open', path: 'a.html', query: '?card=plan' }),
    ).toMatchObject({
      query: '?card=plan',
    });
    expect(pagesFrameMessage({ type: 'whombat.pages.open', path: 'a.html', query: 'x' })).toMatchObject({
      query: '',
    });
  });
});

describe('base64Of', () => {
  it('matches the platform’s base64', () => {
    for (const n of [0, 1, 2, 3, 3071, 3072, 3073, 10000]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37) % 256);
      expect(base64Of(bytes), String(n)).toBe(bytesToBase64(bytes));
    }
  });
});
