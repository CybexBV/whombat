import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  decodePage,
  isHtml,
  ownOrigins,
  parsePreviewHtml,
  previewOf,
  previewUrls,
} from './extract';

describe('previewUrls', () => {
  it('takes http(s) links in order, each once, at most three', () => {
    expect(
      previewUrls(
        'See https://a.example/x and [the docs](https://b.example/doc), again https://a.example/x, then http://c.example and https://d.example',
      ),
    ).toEqual(['https://a.example/x', 'https://b.example/doc', 'http://c.example']);
  });

  it('skips code blocks, code spans, images and other schemes', () => {
    const text = [
      'Try `https://inline.example/code`',
      '```',
      'curl https://block.example/api',
      '```',
      '![logo](https://img.example/logo.png)',
      '[mail](mailto:a@b.example) ftp://files.example/x',
      '> quoted https://quote.example/ok',
    ].join('\n');
    expect(previewUrls(text)).toEqual(['https://quote.example/ok']);
  });

  it('leaves this Whombat’s own links out', () => {
    const own = ownOrigins(['https://app.whombat.test', null, 'not a url']);
    expect(
      previewUrls('Open https://app.whombat.test/burrow-hq/c/general or https://news.example/a', {
        ownOrigins: own,
      }),
    ).toEqual(['https://news.example/a']);
  });

  it('finds links in lists, headings and tables', () => {
    expect(
      previewUrls('# https://h.example\n\n- https://l.example\n\n| a |\n|---|\n| https://t.example |'),
    ).toEqual(['https://h.example', 'https://l.example', 'https://t.example']);
  });
});

describe('parsePreviewHtml', () => {
  it('prefers Open Graph, then the title and the description meta', () => {
    const html = `<!doctype html><html><head>
      <title>Plain title</title>
      <meta name="description" content="Plain description">
      <meta property="og:title" content="OG &amp; title">
      <meta property='og:site_name' content='Example'>
      </head><body><meta property="og:description" content="in the body, ignored"></body></html>`;
    expect(parsePreviewHtml(html)).toEqual({
      title: 'OG & title',
      description: 'Plain description',
      siteName: 'Example',
    });
  });

  it('falls back to <title>, decodes entities and collapses whitespace', () => {
    expect(
      parsePreviewHtml('<head><title>\n  Caf&eacute; &#8212; &#x2603; &quot;menu&quot;  \n</title></head>'),
    ).toEqual({ title: 'Caf&eacute; — ☃ "menu"', description: null, siteName: null });
  });

  it('ignores scripts and comments', () => {
    const html =
      '<head><!-- <title>no</title> --><script>var t="<title>no</title>"</script><title>yes</title></head>';
    expect(parsePreviewHtml(html).title).toBe('yes');
  });

  it('makes no preview for a page without a title, and cuts long fields', () => {
    expect(
      previewOf('https://x.example', '<head><meta name="description" content="only this"></head>'),
    ).toBeNull();
    const long = previewOf('https://x.example', `<head><title>${'t'.repeat(300)}</title></head>`);
    expect(long?.title.length).toBe(200);
    expect(long?.title.endsWith('…')).toBe(true);
  });

  it('decodes numeric entities safely', () => {
    expect(decodeEntities('&#0;&#xD800;&#65;&unknown;')).toBe('A&unknown;');
  });
});

describe('pages', () => {
  it('reads the charset from the header, else the document', () => {
    const latin1 = Buffer.from('<head><meta charset="iso-8859-1"><title>Café</title></head>', 'latin1');
    expect(parsePreviewHtml(decodePage('text/html', latin1)).title).toBe('Café');
    const utf8 = Buffer.from('<title>Café</title>', 'utf8');
    expect(parsePreviewHtml(decodePage('text/html; charset=utf-8', utf8)).title).toBe('Café');
    expect(parsePreviewHtml(decodePage('text/html; charset=bogus', utf8)).title).toBe('Café');
  });

  it('knows an HTML page', () => {
    expect(isHtml('text/html; charset=utf-8')).toBe(true);
    expect(isHtml('application/xhtml+xml')).toBe(true);
    expect(isHtml('application/json')).toBe(false);
    expect(isHtml(undefined)).toBe(false);
  });
});
