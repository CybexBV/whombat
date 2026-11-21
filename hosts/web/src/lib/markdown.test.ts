import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, parseInline, parseMarkdown, safeHref } from './markdown';

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('markdown', () => {
  it('builds paragraphs with line breaks, headings as bold lines and rules', () => {
    expect(html('One\ntwo\n\nThree')).toBe('<div class="md"><p>One<br/>two</p><p>Three</p></div>');
    expect(html('## What is wrong\nText')).toBe('<div class="md"><p class="md-h"><strong>What is wrong</strong></p><p>Text</p></div>');
    expect(html('a\n\n---\n\nb')).toBe('<div class="md"><p>a</p><hr/><p>b</p></div>');
    expect(parseMarkdown('#hashtag')).toEqual([{ t: 'p', c: [{ t: 'text', v: '#hashtag' }] }]);
  });

  it('parses bullet and numbered lists, nested and loose', () => {
    expect(html('- one\n- two\n  - nested\n- three')).toBe('<div class="md"><ul><li><p>one</p></li><li><p>two</p><ul><li><p>nested</p></li></ul></li><li><p>three</p></li></ul></div>');
    expect(html('3. first\n4. second')).toBe('<div class="md"><ol start="3"><li><p>first</p></li><li><p>second</p></li></ol></div>');
    const loose = parseMarkdown('1. Check the disk\n\n   It has errors.\n\n2. Replace it\n\nAfter the list');
    expect(loose).toHaveLength(2);
    expect(loose[0]).toMatchObject({ t: 'list', ordered: true, items: [[{ t: 'p' }, { t: 'p' }], [{ t: 'p' }]] });
    expect(loose[1]).toEqual({ t: 'p', c: [{ t: 'text', v: 'After the list' }] });
    // A lazy continuation line belongs to the item; a new kind of list starts another list.
    expect(parseMarkdown('- one\ncontinued\n1. other')).toMatchObject([{ t: 'list', ordered: false, items: [[{ t: 'p', c: [{ v: 'one' }, { t: 'br' }, { v: 'continued' }] }]] }, { t: 'list', ordered: true }]);
  });

  it('keeps fenced code verbatim and escapes it', () => {
    expect(parseMarkdown('```bash\nsmartctl -x /dev/sdc | grep **x**\n<b>hi</b>\n```')).toEqual([{ t: 'code', lang: 'bash', v: 'smartctl -x /dev/sdc | grep **x**\n<b>hi</b>' }]);
    expect(html('```\n<script>alert(1)</script>\n```')).toBe('<div class="md"><pre class="md-pre" tabindex="0"><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre></div>');
    // An unclosed fence runs to the end.
    expect(parseMarkdown('~~~\na\nb')).toEqual([{ t: 'code', lang: '', v: 'a\nb' }]);
  });

  it('parses inline code, bold, italics and escapes', () => {
    expect(parseInline('Run `smartctl -t short` **now**, *please*')).toEqual([
      { t: 'text', v: 'Run ' },
      { t: 'code', v: 'smartctl -t short' },
      { t: 'text', v: ' ' },
      { t: 'strong', c: [{ t: 'text', v: 'now' }] },
      { t: 'text', v: ', ' },
      { t: 'em', c: [{ t: 'text', v: 'please' }] },
    ]);
    expect(parseInline('`a ** b` and __bold__ and _it_')).toEqual([
      { t: 'code', v: 'a ** b' },
      { t: 'text', v: ' and ' },
      { t: 'strong', c: [{ t: 'text', v: 'bold' }] },
      { t: 'text', v: ' and ' },
      { t: 'em', c: [{ t: 'text', v: 'it' }] },
    ]);
    expect(parseInline('*a **b** c*')).toEqual([{ t: 'em', c: [{ t: 'text', v: 'a ' }, { t: 'strong', c: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' c' }] }]);
    expect(parseInline('snake_case_name, 2 * 3 * 4, \\*literal\\*, ** alone')).toEqual([{ t: 'text', v: 'snake_case_name, 2 * 3 * 4, *literal*, ** alone' }]);
    expect(parseInline('``code with ` tick``')).toEqual([{ t: 'code', v: 'code with ` tick' }]);
  });

  it('links http(s) only, in a new tab, and never nests them', () => {
    expect(html('See [the docs](https://docs.example.com/a_(b)) now')).toBe(
      '<div class="md"><p>See <a href="https://docs.example.com/a_(b)" target="_blank" rel="noopener noreferrer">the docs</a> now</p></div>',
    );
    expect(html('[click](javascript:alert(1)) and [x](data:text/html,hi)')).toBe('<div class="md"><p>click and x</p></div>');
    expect(html('Open https://example.com/x?y=1. Or <https://a.example>')).toBe(
      '<div class="md"><p>Open <a href="https://example.com/x?y=1" target="_blank" rel="noopener noreferrer">https://example.com/x?y=1</a>. Or <a href="https://a.example/" target="_blank" rel="noopener noreferrer">https://a.example</a></p></div>',
    );
    expect(html('[https://example.com](https://example.com)')).toBe('<div class="md"><p><a href="https://example.com/" target="_blank" rel="noopener noreferrer">https://example.com</a></p></div>');
    expect(safeHref('ftp://x')).toBeNull();
    expect(safeHref('not a url')).toBeNull();
  });

  it('renders raw HTML as text', () => {
    expect(html('<img src=x onerror=alert(1)> <b>bold</b>')).toBe('<div class="md"><p>&lt;img src=x onerror=alert(1)&gt; &lt;b&gt;bold&lt;/b&gt;</p></div>');
  });

  it('parses quotes and tables', () => {
    expect(html('> quoted\n> more')).toBe('<div class="md"><blockquote><p>quoted<br/>more</p></blockquote></div>');
    const t = parseMarkdown('| Disk | Errors |\n|:-----|------:|\n| sdc | 1,184 |\n| sdd | 0 |');
    expect(t).toEqual([
      {
        t: 'table',
        align: ['left', 'right'],
        head: [[{ t: 'text', v: 'Disk' }], [{ t: 'text', v: 'Errors' }]],
        rows: [
          [[{ t: 'text', v: 'sdc' }], [{ t: 'text', v: '1,184' }]],
          [[{ t: 'text', v: 'sdd' }], [{ t: 'text', v: '0' }]],
        ],
      },
    ]);
    expect(html('a | b\n--|--\n`x\\|y` | 2')).toContain('<td><code class="md-code">x|y</code></td>');
  });
});
