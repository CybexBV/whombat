import { describe, expect, it } from 'vitest';
import {
  base64,
  fromBase64,
  isSvgAttachment,
  SVG_PREVIEW_MAX_BYTES,
  showsSvgPreview,
  svgDataUri,
  svgForNative,
  svgFromDataUri,
  svgIntrinsicSize,
} from './svg';

describe('SVG attachments (AP-100)', () => {
  it('knows an SVG by its type or its name', () => {
    expect(isSvgAttachment({ contentType: 'image/svg+xml', name: 'x' })).toBe(true);
    expect(isSvgAttachment({ contentType: 'image/svg+xml; charset=utf-8', name: 'x' })).toBe(true);
    expect(isSvgAttachment({ contentType: 'text/plain', name: 'Diagram.SVG' })).toBe(true);
    expect(isSvgAttachment({ contentType: 'text/plain', name: 'notes.txt' })).toBe(false);
    expect(isSvgAttachment({ contentType: 'image/png', name: 'svg.png' })).toBe(false);
  });

  it('keeps large ones a download', () => {
    const a = { contentType: 'image/svg+xml', name: 'a.svg' };
    expect(showsSvgPreview({ ...a, size: SVG_PREVIEW_MAX_BYTES })).toBe(true);
    expect(showsSvgPreview({ ...a, size: SVG_PREVIEW_MAX_BYTES + 1 })).toBe(false);
  });

  it('encodes base64 like Node', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['a', 'YQ=='],
      ['ab', 'YWI='],
      ['abc', 'YWJj'],
      ['abcd', 'YWJjZA=='],
      ['€ “x”', '4oKsIOKAnHjigJ0='],
    ];
    for (const [text, encoded] of vectors) expect(base64(new TextEncoder().encode(text))).toBe(encoded);
    expect(svgDataUri(new TextEncoder().encode('<svg/>'))).toBe('data:image/svg+xml;base64,PHN2Zy8+');
  });

  it('reads the picture’s size from the root element', () => {
    expect(svgIntrinsicSize('<svg width="120" height="80px"></svg>')).toEqual({ width: 120, height: 80 });
    expect(svgIntrinsicSize('<?xml?><svg viewBox="0 0 400 200"/>')).toEqual({ width: 400, height: 200 });
    expect(svgIntrinsicSize('<svg width="100" viewBox="0,0,400,200">')).toEqual({ width: 100, height: 50 });
    expect(svgIntrinsicSize('<svg width="100%" height="100%">')).toBeNull();
    expect(svgIntrinsicSize('not svg')).toBeNull();
  });

  it('keeps a native renderer from fetching anything', () => {
    const xml =
      '<svg><script>alert(1)</script><image href="https://t.example/p.png"/><image xlink:href="data:image/png;base64,AA"/>' +
      '<foreignObject><div/></foreignObject><image href="//x"></image><rect/></svg>';
    expect(svgForNative(xml)).toBe('<svg><image xlink:href="data:image/png;base64,AA"/><rect/></svg>');
  });

  it('reads an SVG back out of a data: URL', () => {
    const doc = '<svg xmlns="http://www.w3.org/2000/svg"><text>€ “x”</text></svg>';
    const bytes = new TextEncoder().encode(doc);
    expect(svgFromDataUri(svgDataUri(bytes))).toBe(doc);
    expect(svgFromDataUri(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(doc)}`)).toBe(doc);
    expect(svgFromDataUri('data:image/png;base64,AAAA')).toBeNull();
    expect(svgFromDataUri('https://example.com/a.svg')).toBeNull();
    expect(fromBase64('YWJjZA==')).toEqual(new TextEncoder().encode('abcd'));
    expect(fromBase64('not base64!')).toBeNull();
  });
});
