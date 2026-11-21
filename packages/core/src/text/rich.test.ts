import { describe, expect, it } from 'vitest';
import { HTML_PREVIEW_MAX, htmlTitle, isHtmlDocument, isHtmlPreviewable } from './html.js';
import { isSafeImageSrc } from './images.js';
import {
  type Block,
  codePreview,
  type Inline,
  MERMAID_PREVIEW_MAX,
  parseMessage,
  plainMessageText,
} from './markdown.js';
import { attachmentPreview, baseContentType, contentTypeForName } from './media.js';

const text = (t: string): Inline => ({ type: 'text', text: t });
const para = (...children: Inline[]): Block => ({ type: 'paragraph', children });

/** The representative page of the assignment: a logo presentation with inline SVG, styles, a font and a script. */
const LOGO_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Dusty &amp; the new logo</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: Inter, sans-serif; margin: 0; }

    .logo { width: 240px; }
  </style>
</head>
<body>
  <svg class="logo" viewBox="0 0 10 10"><title>Mark</title><circle cx="5" cy="5" r="4"/></svg>

  <p>Three variants below.</p>
  <script>document.querySelector('p').textContent += ' (loaded)';</script>
</body>
</html>`;

describe('headings (CT-149)', () => {
  it('keeps the level from one to six hashes', () => {
    const blocks = parseMessage('# One\n###### Six\n####### seven');
    expect(blocks).toEqual([
      { type: 'heading', level: 1, children: [text('One')] },
      { type: 'heading', level: 6, children: [text('Six')] },
      para(text('####### seven')),
    ]);
  });
});

describe('task lists (CT-149)', () => {
  it('marks checked, unchecked and ordinary items', () => {
    const [list] = parseMessage(
      '- [x] Ship it\n- [ ] Tell Mara\n- plain\n- [X] done too\n- [link](https://x.io)',
    );
    expect(list).toEqual({
      type: 'list',
      ordered: false,
      start: 1,
      checked: [true, false, null, true, null],
      items: [
        [para(text('Ship it'))],
        [para(text('Tell Mara'))],
        [para(text('plain'))],
        [para(text('done too'))],
        [para({ type: 'link', href: 'https://x.io', children: [text('link')] })],
      ],
    });
  });

  it('leaves `checked` out of a list without task items, and works nested and ordered', () => {
    expect(parseMessage('- a\n- b')[0]).not.toHaveProperty('checked');
    const [list] = parseMessage('1. [ ] first\n   - [x] sub');
    expect(list).toMatchObject({ ordered: true, checked: [false] });
    expect((list as Extract<Block, { type: 'list' }>).items[0]?.[1]).toMatchObject({ checked: [true] });
  });
});

describe('quotes (CT-149)', () => {
  it('nests quotes with `> >` and `>>`', () => {
    expect(parseMessage('> outer\n> > inner\n>> deeper still\n> back')).toEqual([
      {
        type: 'quote',
        children: [
          para(text('outer')),
          { type: 'quote', children: [para(text('inner'), { type: 'break' }, text('deeper still'))] },
          para(text('back')),
        ],
      },
    ]);
  });
});

describe('tables (CT-149)', () => {
  it('parses a GitHub table with alignment, right under a line of text', () => {
    const blocks = parseMessage(
      [
        'Results:',
        '| Plan | Price | Seats |',
        '|:-----|:-----:|------:|',
        '| **Pro** | €20 | 1 |',
        '| Team | `a \\| b` |',
        'After the table.',
      ].join('\n'),
    );
    expect(blocks).toEqual([
      para(text('Results:')),
      {
        type: 'table',
        align: ['left', 'center', 'right'],
        header: [[text('Plan')], [text('Price')], [text('Seats')]],
        rows: [
          [[{ type: 'strong', children: [text('Pro')] }], [text('€20')], [text('1')]],
          [[text('Team')], [{ type: 'code', text: 'a | b' }], []],
        ],
      },
      para(text('After the table.')),
    ]);
  });

  it('accepts tables without outer pipes, drops extra cells and ends at a blank line', () => {
    const [table, after] = parseMessage('a | b\n--- | ---\n1 | 2 | 3\n\nnext');
    expect(table).toEqual({
      type: 'table',
      align: [null, null],
      header: [[text('a')], [text('b')]],
      rows: [[[text('1')], [text('2')]]],
    });
    expect(after).toEqual(para(text('next')));
  });

  it('is not a table without a matching delimiter row', () => {
    expect(parseMessage('a | b\n--- | --- | ---').map((b) => b.type)).toEqual(['paragraph']);
    expect(parseMessage('just a | pipe\nand text').map((b) => b.type)).toEqual(['paragraph']);
    expect(parseMessage('a | b\n-- x | --').map((b) => b.type)).toEqual(['paragraph']);
  });

  it('works inside quotes and list items', () => {
    const [quote] = parseMessage('> | a |\n> |---|\n> | 1 |');
    expect((quote as Extract<Block, { type: 'quote' }>).children[0]).toMatchObject({ type: 'table' });
  });
});

describe('code blocks and previews (CT-149)', () => {
  it('keeps the language, also with an info string after it', () => {
    expect(parseMessage('```ts title="a.ts"\nconst a = 1;\n```')).toEqual([
      { type: 'code', lang: 'ts', text: 'const a = 1;' },
    ]);
  });

  it('previews fenced HTML pages and fragments, not code without tags', () => {
    expect(parseMessage(`\`\`\`html\n${LOGO_PAGE}\n\`\`\``)).toEqual([
      { type: 'code', lang: 'html', text: LOGO_PAGE, preview: 'html' },
    ]);
    expect(parseMessage('```HTM\n<p>Hi <b>there</b></p>\n```')).toEqual([
      { type: 'code', lang: 'HTM', text: '<p>Hi <b>there</b></p>', preview: 'html' },
    ]);
    expect(parseMessage('```html\nno tags here\n```')).toEqual([
      { type: 'code', lang: 'html', text: 'no tags here' },
    ]);
    // A fence without a language: a page is html, a fragment stays code.
    expect(parseMessage(`\`\`\`\n${LOGO_PAGE}\n\`\`\``)).toEqual([
      { type: 'code', lang: 'html', text: LOGO_PAGE, preview: 'html' },
    ]);
    expect(parseMessage('```\n<p>x</p>\n```')).toEqual([{ type: 'code', lang: null, text: '<p>x</p>' }]);
  });

  it('takes a raw HTML page for an html code block, across blank lines', () => {
    const blocks = parseMessage(`Here’s the logo page:\n${LOGO_PAGE}\nWhat do you think?`);
    expect(blocks).toEqual([
      para(text('Here’s the logo page:')),
      { type: 'code', lang: 'html', text: LOGO_PAGE, preview: 'html' },
      para(text('What do you think?')),
    ]);
    const bare = '<html>\n<body>\n\n<p>hi</p>\n</body>\n</HTML>';
    expect(parseMessage(bare)).toEqual([{ type: 'code', lang: 'html', text: bare, preview: 'html' }]);
  });

  it('runs an unclosed <!DOCTYPE html> page to the end, but keeps an unclosed <html> as text', () => {
    expect(parseMessage('<!doctype html>\n<p>cut off')).toEqual([
      { type: 'code', lang: 'html', text: '<!doctype html>\n<p>cut off', preview: 'html' },
    ]);
    expect(parseMessage('<html> is the root element').map((b) => b.type)).toEqual(['paragraph']);
    expect(parseMessage('<htmlish>').map((b) => b.type)).toEqual(['paragraph']);
  });

  it('previews mermaid fences', () => {
    expect(parseMessage('```mermaid\ngraph TD; A-->B\n```')).toEqual([
      { type: 'code', lang: 'mermaid', text: 'graph TD; A-->B', preview: 'mermaid' },
    ]);
    expect(parseMessage('```mermaid\n\n```')).toEqual([{ type: 'code', lang: 'mermaid', text: '' }]);
    expect(codePreview('mermaid', 'x'.repeat(MERMAID_PREVIEW_MAX + 1))).toBeNull();
  });

  it('codePreview decides from the language and the text', () => {
    const svg = '<svg viewBox="0 0 1 1"></svg>';
    expect(codePreview('svg', svg)).toBe('svg');
    expect(codePreview('svg', 'nope')).toBeNull();
    expect(codePreview('html', svg)).toBeNull();
    expect(codePreview('xhtml', '<p/>')).toBe('html');
    expect(codePreview(null, LOGO_PAGE)).toBe('html');
    expect(codePreview('ts', LOGO_PAGE)).toBeNull();
  });

  it('gives the same output for the same text', () => {
    const src = `# T\n| a |\n|---|\n| 1 |\n- [ ] x\n${LOGO_PAGE}`;
    expect(parseMessage(src)).toEqual(parseMessage(src));
  });
});

describe('plainMessageText (CT-149)', () => {
  it('names pages and diagrams, flattens tables and task items', () => {
    expect(
      plainMessageText(
        `${LOGO_PAGE}\n\n\`\`\`mermaid\ngraph TD\n\`\`\`\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] open`,
      ),
    ).toBe('[page: Dusty & the new logo]\n[diagram]\na | b\n1 | 2\n• ☑ done\n• ☐ open');
    expect(plainMessageText('```html\n<p>x</p>\n```')).toBe('[page]');
  });
});

describe('HTML helpers (CT-150)', () => {
  it('recognises documents', () => {
    expect(isHtmlDocument(LOGO_PAGE)).toBe(true);
    expect(isHtmlDocument('﻿<!-- made by Dusty -->\n<HTML>')).toBe(true);
    expect(isHtmlDocument('<p>fragment</p>')).toBe(false);
    expect(isHtmlDocument(`<!DOCTYPE html>${' '.repeat(HTML_PREVIEW_MAX)}`)).toBe(false);
  });

  it('previews fragments but not a lone SVG or plain text', () => {
    expect(isHtmlPreviewable('<div class="x">hi</div>')).toBe(true);
    expect(isHtmlPreviewable('<svg viewBox="0 0 1 1"></svg>')).toBe(false);
    expect(isHtmlPreviewable('a < b and c > d')).toBe(false);
    expect(isHtmlPreviewable('   ')).toBe(false);
  });

  it('reads the page title, not an inline SVG’s', () => {
    expect(htmlTitle(LOGO_PAGE)).toBe('Dusty & the new logo');
    expect(htmlTitle('<title>  A\n  &#8220;quoted&#x201D; &mdash; x </title>')).toBe('A “quoted” — x');
    expect(htmlTitle('<body><svg><title>Mark</title></svg></body>')).toBeNull();
    expect(htmlTitle('<title> </title>')).toBeNull();
    expect(htmlTitle(`<title>${'a'.repeat(300)}</title>`)).toHaveLength(200);
  });
});

describe('images and attachments (CT-152)', () => {
  it('accepts AVIF data images', () => {
    expect(isSafeImageSrc('data:image/avif;base64,AAAA')).toBe(true);
    expect(isSafeImageSrc('data:image/bmp;base64,AAAA')).toBe(false);
  });

  it('maps names and types', () => {
    expect(contentTypeForName('Logo.HTML')).toBe('text/html');
    expect(contentTypeForName('clip.mov')).toBe('video/quicktime');
    expect(contentTypeForName('README')).toBeNull();
    expect(baseContentType('Text/HTML; charset=utf-8')).toBe('text/html');
  });

  it('decides how to show an attachment', () => {
    const p = (name: string, contentType: string, kind?: 'image' | 'text' | 'document' | 'file') =>
      attachmentPreview({ name, contentType, kind });
    expect(p('a.png', 'image/png', 'image')).toBe('image');
    expect(p('a.avif', 'image/avif', 'file')).toBe('image');
    expect(p('a.avif', 'application/octet-stream', 'file')).toBe('image');
    expect(p('a.png', 'text/plain', 'text')).toBe('text');
    expect(p('logo.svg', 'image/svg+xml', 'text')).toBe('svg');
    expect(p('logo.svg', 'text/xml', 'text')).toBe('svg');
    expect(p('logo.html', 'text/html; charset=utf-8', 'text')).toBe('html');
    expect(p('logo.html', 'text/plain', 'text')).toBe('html');
    expect(p('page', 'text/html', 'text')).toBe('html');
    expect(p('flow.mmd', 'text/plain', 'text')).toBe('mermaid');
    expect(p('spec.pdf', 'application/pdf', 'document')).toBe('pdf');
    expect(p('call.m4a', 'audio/mp4', 'file')).toBe('audio');
    expect(p('call.mp3', 'application/octet-stream', 'file')).toBe('audio');
    expect(p('demo.webm', 'video/webm', 'file')).toBe('video');
    expect(p('notes.md', 'text/markdown', 'text')).toBe('text');
    expect(p('x.zip', 'application/zip', 'file')).toBeNull();
  });
});
