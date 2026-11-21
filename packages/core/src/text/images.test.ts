import { describe, expect, it } from 'vitest';
import { isSafeImageSrc, isSvgDocument, SVG_IMAGE_MAX, svgImageDocument, svgImageSrc } from './images.js';

describe('isSafeImageSrc', () => {
  it('allows http(s) and data: PNG, JPEG, GIF, WebP and SVG', () => {
    for (const src of [
      'https://x.io/a.png',
      'HTTP://x.io/a',
      'data:image/png;base64,iVBO',
      'data:image/JPEG;base64,/9j/',
      'data:image/gif,x',
      'data:image/webp;base64,UklG',
      'data:image/svg+xml;charset=utf-8,%3Csvg%3E',
    ])
      expect(isSafeImageSrc(src), src).toBe(true);
  });

  it('refuses everything else', () => {
    for (const src of [
      'javascript:alert(1)',
      'data:text/html,<script>',
      'data:image/svg+xml,<svg onload="x">',
      'data:image/bmp;base64,Qk0=',
      'data:application/pdf;base64,JVBE',
      'ftp://x.io/a.png',
      '//x.io/a.png',
      'https://x.io/a b.png',
      '',
    ])
      expect(isSafeImageSrc(src), src).toBe(false);
  });
});

describe('svgImageSrc', () => {
  it('encodes a standalone SVG document, adding the namespaces it needs', () => {
    const src = svgImageSrc('  <svg viewBox="0 0 1 1"><use xlink:href="#a"/><text>€ 5 ·</text></svg>\n');
    expect(src?.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent((src as string).split(',')[1] as string)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><use xlink:href="#a"/><text>€ 5 ·</text></svg>',
    );
    expect(isSafeImageSrc(src as string)).toBe(true);
  });

  it('keeps a prolog, comments and a plain DOCTYPE, and a namespace that is there', () => {
    const doc =
      '<?xml version="1.0"?>\n<!-- chart -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    expect(svgImageDocument(doc)).toBe(doc);
  });

  it('refuses what is not one SVG document', () => {
    for (const text of [
      '<div><svg></svg></div>',
      '<svg></svg><p>after</p>',
      'text <svg></svg>',
      '<svgx></svgx>',
      '<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>',
      `<svg>${'x'.repeat(SVG_IMAGE_MAX)}</svg>`,
      '<svg>\uD800</svg>',
    ])
      expect(svgImageSrc(text), text.slice(0, 40)).toBeNull();
    expect(isSvgDocument('<svg/>')).toBe(false);
  });
});
