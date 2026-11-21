// @vitest-environment node
/**
 * The embed tree (Whombat `docs/decisions/feedback-drop.md` FD-29, FD-31; AP-107): its layout, the static
 * `frame.html` and `_headers`, the same widget bytes as the self-hosted build, and a frame bundle without storage.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildWidget,
  controlOriginOf,
  embedCsp,
  FRAME_BANNED,
  FRAME_STORAGE_MODULE,
  frameSourceViolations,
  frameViolations,
  type WidgetManifest,
} from '../scripts/build';

const CONTROL = 'https://api.dev.whombat.com';
let dir: string;
let manifest: WidgetManifest;

function files(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }))
      e.isDirectory() ? walk(join(d, e.name)) : out.push(relative(root, join(d, e.name)));
  };
  walk(root);
  return out.sort();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-embed-'));
  await buildWidget(join(dir, 'direct'));
  ({ manifest } = await buildWidget(join(dir, 'embed'), { control: controlOriginOf(`${CONTROL}/v1`) }));
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the embed tree', () => {
  it('is embed/v1 with frame.html, plus _headers at its root', () => {
    expect(files(join(dir, 'embed'))).toEqual(
      [
        '_headers',
        'embed/v1/frame.html',
        'embed/v1/manifest.json',
        'embed/v1/widget.js',
        `embed/v1/${manifest.frame.css}`,
        `embed/v1/${manifest.frame.js}`,
      ].sort(),
    );
  });

  it('carries exactly the self-hosted build’s widget bytes', () => {
    for (const name of Object.keys(manifest.files))
      expect(readFileSync(join(dir, 'embed/embed/v1', name))).toEqual(
        readFileSync(join(dir, 'direct/v1', name)),
      );
  });

  it('frame.html names control, sets the policy first and inlines nothing', () => {
    const html = readFileSync(join(dir, 'embed/embed/v1/frame.html'), 'utf8');
    expect(html).toContain(`<meta name="whombat-control" content="${CONTROL}">`);
    const csp = html.indexOf('http-equiv="Content-Security-Policy"');
    expect(csp).toBeGreaterThan(0);
    expect(csp).toBeLessThan(html.indexOf('<link'));
    expect(html).toContain(`content="${embedCsp(CONTROL, false)}"`);
    expect(embedCsp(CONTROL, false)).not.toContain('frame-ancestors');
    expect(html).toContain(`<script src="${manifest.frame.js}" defer></script>`);
    expect(html).not.toMatch(/<script>|<style|style=/);
    expect(html).toContain('<div id="wb-root"></div>');
  });

  it('_headers frames anywhere, connects to control only and caches like the self-hosted server', () => {
    const headers = readFileSync(join(dir, 'embed/_headers'), 'utf8');
    expect(headers).toBe(`/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src ${CONTROL}; form-action 'none'; base-uri 'none'; frame-ancestors *
  Cross-Origin-Resource-Policy: cross-origin
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Strict-Transport-Security: max-age=63072000; includeSubDomains
/embed/v1/widget.js
  Cache-Control: public, max-age=300
/embed/v1/frame.html
  Cache-Control: public, max-age=300
/embed/v1/assets/*
  Cache-Control: public, max-age=31536000, immutable
`);
    expect(headers).not.toMatch(/X-Frame-Options|frame-ancestors 'none'/);
  });

  it('needs a control URL: https, or http on loopback', () => {
    expect(controlOriginOf('https://api.whombat.com/')).toBe('https://api.whombat.com');
    expect(controlOriginOf('http://127.0.0.1:4455')).toBe('http://127.0.0.1:4455');
    for (const bad of [undefined, '', 'api.whombat.com', 'http://api.whombat.com', 'ftp://x'])
      expect(() => controlOriginOf(bad)).toThrow(/control’s URL/);
  });
});

describe('the frame bundle (FD-28 (7), AP-429)', () => {
  it('uses no storage but the reporter session’s localStorage key, no HTML parsing and no eval', () => {
    const js = readFileSync(join(dir, 'embed/embed/v1', manifest.frame.js), 'utf8');
    expect(frameViolations(js)).toEqual([]);
    // localStorage appears only through the storage module (the build checked every source it bundled).
    expect(js).toContain('localStorage');
    expect(readFileSync(join(import.meta.dirname, '..', FRAME_STORAGE_MODULE), 'utf8')).toContain(
      'window.localStorage',
    );
  });

  it('localStorage is allowed in the storage module only', () => {
    expect(
      frameSourceViolations([
        { path: FRAME_STORAGE_MODULE, text: 'window.localStorage.getItem(k)' },
        { path: 'src/frame/app.ts', text: 'const s = localStorage;' },
        { path: '../../node_modules/lib/index.js', text: 'window["localStorage"]' },
        { path: 'src/frame/drop.ts', text: 'no storage here' },
      ]),
    ).toEqual(['src/frame/app.ts', '../../node_modules/lib/index.js']);
  });

  it('the check catches each of the others', () => {
    const uses = [
      'document.cookie="a=1"',
      'cookieStore.get("a")',
      'sessionStorage.getItem("a")',
      'indexedDB.open("a")',
      'caches.open("a")',
      'navigator.serviceWorker.register("/sw.js")',
      'openDatabase("a")',
      'el.innerHTML=x',
      'eval(x)',
    ];
    for (const use of uses) expect(frameViolations(use), use).not.toEqual([]);
    expect(frameViolations('"no cookies, stored data, form contents"')).toEqual([]);
    expect(FRAME_BANNED.length).toBeGreaterThan(0);
  });
});
