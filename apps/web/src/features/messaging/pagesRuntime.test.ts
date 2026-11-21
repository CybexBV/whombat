/**
 * The page set viewer's script (`@whombat/client/pages/pages-runtime.js`, docs/decisions/page-sets.md) in a document of its own:
 * it asks for the page and its files by path and writes the page with them in place. Driven through the phone's channel
 * (`window.ReactNativeWebView`, `window.__whombatPages`), which needs no frame.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { base64Of } from '@whombat/client/pages';
import { pageFileType } from '@whombat/core';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const SOURCE = readFileSync(require.resolve('@whombat/client/pages/pages-runtime.js'), 'utf8');
const text = (s: string) => new TextEncoder().encode(s);

type Sent = { type: string; [k: string]: unknown };

function run(files: Record<string, Uint8Array>) {
  const sent: Sent[] = [];
  let blobs = 0;
  URL.createObjectURL = () => `blob:test/${++blobs}`;
  const answer = (m: Sent) => {
    const bytes = files[m.path as string];
    const reply = bytes
      ? {
          type: 'whombat.pages.file',
          id: m.id,
          ok: true,
          contentType: pageFileType(m.path as string),
          base64: base64Of(bytes),
        }
      : { type: 'whombat.pages.file', id: m.id, ok: false };
    setTimeout(
      () =>
        (window as unknown as { __whombatPages: (d: unknown) => void }).__whombatPages(JSON.stringify(reply)),
      0,
    );
  };
  const native = {
    postMessage(json: string) {
      const m = JSON.parse(json) as Sent;
      sent.push(m);
      if (m.type === 'whombat.pages.need') answer(m);
    },
  };
  Object.assign(window, { ReactNativeWebView: native });
  new Function(SOURCE)();
  const shown = () =>
    new Promise<Sent>((resolve) => {
      const check = () => {
        const done = sent.find(
          (m) =>
            m.type === 'whombat.pages.shown' ||
            m.type === 'whombat.pages.failed' ||
            m.type === 'whombat.pages.open',
        );
        if (done) resolve(done);
        else setTimeout(check, 5);
      };
      check();
    });
  const show = (path: string, query = '') =>
    (window as unknown as { __whombatPages: (d: unknown) => void }).__whombatPages({
      type: 'whombat.pages.show',
      path,
      hash: '',
      query,
    });
  return { sent, show, shown };
}

afterEach(() => {
  delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
});

describe('the page set viewer', () => {
  it('writes a page with its pictures, styles, fonts and scripts in place', async () => {
    const v = run({
      'round-2/index.html': text(
        '<!doctype html><html><head><title>Round 2</title><link rel="stylesheet" href="../style.css"><script src="app.js"></script></head><body><img src="shots/a.png" srcset="shots/a.png 1x, shots/a@2x.png 2x"><a href="../index.html#top">Back</a><a href="https://example.com">Out</a></body></html>',
      ),
      'style.css': text(
        '@font-face{font-family:B;src:url(fonts/b.woff2)}body{background:url("round-2/shots/a.png")}',
      ),
      'fonts/b.woff2': new Uint8Array([1, 2, 3]),
      'round-2/shots/a.png': new Uint8Array([137, 80, 78, 71]),
      'round-2/shots/a@2x.png': new Uint8Array([137, 80, 78, 71, 2]),
      'round-2/app.js': text('window.__ran = "</script>";'),
    });
    expect(v.sent[0]).toEqual({ type: 'whombat.pages.ready' });
    v.show('round-2/index.html');
    expect(await v.shown()).toEqual({
      type: 'whombat.pages.shown',
      path: 'round-2/index.html',
      title: 'Round 2',
    });
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toMatch(/^blob:test\//);
    expect(img?.getAttribute('srcset')).toMatch(/^blob:test\/\d+ 1x, blob:test\/\d+ 2x$/);
    const css = document.querySelector('style')?.textContent ?? '';
    expect(css).toContain('url("data:font/woff2;base64,AQID")');
    expect(css).toMatch(/background:url\("blob:test\/\d+"\)/);
    expect(document.querySelector('link[rel="stylesheet"]')).toBeNull();
    const script = document.querySelector('script');
    expect(script?.hasAttribute('src')).toBe(false);
    expect(script?.textContent).toContain('window.__ran');
    const back = document.querySelector('a[href="../index.html#top"]');
    expect(back?.getAttribute('data-whombat-path')).toBe('index.html');
    expect(back?.getAttribute('data-whombat-hash')).toBe('#top');
    expect(document.querySelector('a[href^="https:"]')?.hasAttribute('data-whombat-external')).toBe(true);
    // Every file was asked for by its path in the set, once.
    const asked = v.sent.filter((m) => m.type === 'whombat.pages.need').map((m) => m.path);
    expect(new Set(asked).size).toBe(asked.length);
  });

  it('sends a click on a link of the set to the app', async () => {
    const v = run({ 'index.html': text('<a id="go" href="about/">About</a>') });
    v.show('index.html');
    await v.shown();
    document
      .getElementById('go')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(v.sent.at(-1)).toEqual({
      type: 'whombat.pages.open',
      path: 'about/index.html',
      hash: '',
      query: '',
    });
    // A link the page's script adds later opens in the set too.
    const later = document.createElement('a');
    later.href = 'notes.html#b';
    document.body.append(later);
    later.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(v.sent.at(-1)).toEqual({ type: 'whombat.pages.open', path: 'notes.html', hash: '#b', query: '' });
  });

  it('follows a page that sends you on', async () => {
    const v = run({ 'index.html': text('<meta http-equiv="refresh" content="0;url=docs/index.html">') });
    v.show('index.html');
    expect(await v.shown()).toEqual({
      type: 'whombat.pages.open',
      path: 'docs/index.html',
      hash: '',
      query: '',
    });
  });

  it('keeps a page working after it is written: its address, fetch, and what its scripts add', async () => {
    const v = run({
      'cards/index.html': text(
        '<title>Cards</title><a id="mine" href="mockup.html?decisions=1">Decisions</a><iframe src="mockup.html?card=plan" style="width:400px;height:300px"></iframe><div id="slot"></div>',
      ),
      'cards/png/a.png': new Uint8Array([137, 80, 78, 71]),
      'cards/data.json': text('{"cards":3}'),
      'cards/evidence.js': text('window.__evidence = 1;'),
    });
    v.show('cards/index.html', '?card=plan');
    await v.shown();
    // The page reads its settings from its address.
    expect(location.search).toBe('?card=plan');
    // Its own data comes from the set; nothing else is fetched.
    const got = await fetch('data.json');
    expect(await got.json()).toEqual({ cards: 3 });
    expect((await fetch('missing.json')).status).toBe(404);
    // A picture its script writes in, and one it sets by address.
    const slot = document.getElementById('slot') as HTMLElement;
    slot.innerHTML = '<img id="later" src="png/a.png">';
    const img = document.createElement('img');
    img.src = 'png/a.png';
    // A script it adds by address runs from the set and says it loaded.
    const script = document.createElement('script');
    let loaded = false;
    script.onload = () => {
      loaded = true;
    };
    script.src = 'evidence.js';
    document.head.append(script);
    await new Promise((r) => setTimeout(r, 30));
    expect(document.getElementById('later')?.getAttribute('src')).toMatch(/^blob:test\//);
    expect(img.getAttribute('src')).toMatch(/^blob:test\//);
    expect(script.textContent).toContain('window.__evidence');
    expect(loaded).toBe(true);
    // A frame inside the page becomes a link that opens its page here.
    const frameLink = document.querySelector('a[data-whombat-frame-link]');
    expect(frameLink?.getAttribute('data-whombat-path')).toBe('cards/mockup.html');
    expect(frameLink?.getAttribute('data-whombat-query')).toBe('?card=plan');
    // A link with settings opens the page with them.
    document
      .getElementById('mine')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(v.sent.at(-1)).toEqual({
      type: 'whombat.pages.open',
      path: 'cards/mockup.html',
      hash: '',
      query: '?decisions=1',
    });
  });

  it('says when the page isn’t there', async () => {
    const v = run({});
    v.show('gone.html');
    expect(await v.shown()).toEqual({ type: 'whombat.pages.failed', path: 'gone.html' });
  });
});
