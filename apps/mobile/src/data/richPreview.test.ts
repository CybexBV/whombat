import { readFileSync } from 'node:fs';
import { PAGE_MAX_HEIGHT, PAGE_MIN_HEIGHT, PAGE_STYLE_ID } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  afterPreviewGone,
  HTML_PREVIEW_CSP,
  headingSize,
  PREVIEW_WEBVIEW_PROPS,
  pageHeight,
  previewMayLoad,
  supportsAvif,
  withPreviewPolicy,
} from './richPreview';

const META = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;

describe('HTML previews on mobile (AP-328)', () => {
  it('uses the web frame’s policy', () => {
    const frame = readFileSync(
      new URL('../../../web/public/sandbox/html-frame.html', import.meta.url),
      'utf8',
    );
    expect(frame).toContain(`content="${HTML_PREVIEW_CSP}"`);
    expect(HTML_PREVIEW_CSP).toContain("connect-src 'none'");
    expect(HTML_PREVIEW_CSP).toContain("form-action 'none'");
  });

  it('puts the policy first, so it covers every script of the page', () => {
    const page = '<!-- logo -->\n<!DOCTYPE html>\n<html><head><script>fetch("x")</script></head></html>';
    const out = withPreviewPolicy(page);
    expect(out.startsWith('<!-- logo -->\n<!DOCTYPE html>')).toBe(true);
    expect(out.indexOf(META)).toBeLessThan(out.indexOf('<script>'));
    // No doctype, or a script before the head: still first.
    expect(
      withPreviewPolicy('<script>fetch("x")</script><head></head>').startsWith(`<!doctype html>${META}`),
    ).toBe(true);
    expect(withPreviewPolicy('<svg></svg>').startsWith(`<!doctype html>${META}`)).toBe(true);
    expect(withPreviewPolicy('<!doctype html>x')).toContain('<meta name="referrer" content="no-referrer">');
    expect(withPreviewPolicy('<p>x</p>')).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
  });

  it('loads the page and nothing else, and never hands a URL to the system', () => {
    expect(previewMayLoad('about:blank')).toBe(true);
    for (const url of [
      'https://example.com/',
      'http://10.0.2.2/',
      'data:text/html,<script>fetch(1)</script>',
      'intent://scan/#Intent;scheme=zxing;end',
      'whombat://approvals/1',
      'file:///data/data/com.whombat.mobile/files/x',
      'javascript:alert(1)',
    ])
      expect(previewMayLoad(url), url).toBe(false);
    expect(PREVIEW_WEBVIEW_PROPS.onShouldStartLoadWithRequest({ url: 'https://example.com' })).toBe(false);
    // Everything passes the whitelist, so the library never opens a refused URL with Linking.
    expect(PREVIEW_WEBVIEW_PROPS.originWhitelist).toEqual(['*']);
    expect(PREVIEW_WEBVIEW_PROPS).toMatchObject({
      javaScriptEnabled: true,
      setSupportMultipleWindows: false,
      javaScriptCanOpenWindowsAutomatically: false,
      domStorageEnabled: false,
      allowFileAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      incognito: true,
      mixedContentMode: 'never',
    });
    expect('onMessage' in PREVIEW_WEBVIEW_PROPS).toBe(false);
  });

  it('keeps headings on a modest scale', () => {
    expect(headingSize(1, 15.5)).toEqual({ size: 19.4, weight: 700 });
    expect(headingSize(3, 15.5).size).toBeGreaterThan(15.5);
    expect(headingSize(6, 15.5)).toEqual({ size: 14.6, weight: 600 });
  });

  it('shows AVIF where the platform draws it', () => {
    expect(supportsAvif('android', 31)).toBe(true);
    expect(supportsAvif('android', 30)).toBe(false);
    expect(supportsAvif('ios', '16.4')).toBe(true);
    expect(supportsAvif('ios', '15.7')).toBe(false);
  });

  it('puts the theme after the policy, before the page', () => {
    const out = withPreviewPolicy('<!doctype html><style>p{}</style>', ':root{--x:1}');
    expect(out.indexOf(META)).toBeLessThan(out.indexOf(`id="${PAGE_STYLE_ID}"`));
    expect(out.indexOf(`id="${PAGE_STYLE_ID}"`)).toBeLessThan(out.indexOf('<style>p{}'));
  });

  it('reads only a page’s height, within a message’s limits', () => {
    expect(pageHeight(JSON.stringify({ type: 'whombat.height', height: 412.2 }))).toBe(413);
    expect(pageHeight(JSON.stringify({ type: 'whombat.height', height: 1 }))).toBe(PAGE_MIN_HEIGHT);
    expect(pageHeight(JSON.stringify({ type: 'whombat.height', height: 1e9 }))).toBe(PAGE_MAX_HEIGHT);
    for (const junk of ['x', 'null', '{"type":"whombat.height","height":"9"}', '{"type":"other","height":9}'])
      expect(pageHeight(junk)).toBeNull();
  });
});

describe('a preview whose browser stopped', () => {
  it('starts again twice by itself, then waits for “Try again”', () => {
    expect([0, 1, 2, 3].map(afterPreviewGone)).toEqual(['restart', 'restart', 'offer', 'offer']);
  });
});
