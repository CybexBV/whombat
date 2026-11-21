/** What a preview serves for a path (BT-49, HE-S142). */
import { describe, expect, it } from 'vitest';
import { servedFile, typeOf } from './preview-shot';

describe('a preview’s files (BT-49)', () => {
  const files = new Map([
    ['index.html', ''],
    ['about.html', ''],
    ['docs/index.html', ''],
    ['app.js', ''],
    ['404.html', ''],
  ]);

  it('serves index pages, routes and their html, else the folder’s 404', () => {
    expect(servedFile(files, '/')).toEqual({ status: 200, path: 'index.html' });
    expect(servedFile(files, '/about')).toEqual({ status: 200, path: 'about.html' });
    expect(servedFile(files, '/docs/')).toEqual({ status: 200, path: 'docs/index.html' });
    expect(servedFile(files, '/docs')).toEqual({ status: 200, path: 'docs/index.html' });
    expect(servedFile(files, '/app.js')).toEqual({ status: 200, path: 'app.js' });
    expect(servedFile(files, '/nope')).toEqual({ status: 404, path: '404.html' });
    expect(servedFile(new Map(), '/nope')).toEqual({ status: 404, path: null });
  });

  it('types files by their extension', () => {
    expect(typeOf('a/b.css')).toContain('text/css');
    expect(typeOf('x.WOFF2')).toBe('font/woff2');
    expect(typeOf('blob')).toBe('application/octet-stream');
  });
});
