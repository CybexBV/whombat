import { describe, expect, it } from 'vitest';
import {
  type Block,
  type Inline,
  inlineText,
  parseInline,
  parseMessage,
  plainMessageText,
  smartQuotes,
} from './markdown.js';

const text = (t: string): Inline => ({ type: 'text', text: t });
const para = (...children: Inline[]): Block => ({ type: 'paragraph', children });

describe('parseInline', () => {
  it('parses bold, italic, strike and code', () => {
    expect(parseInline('**Worth** a *look* ~~no~~ `CI / check`')).toEqual([
      { type: 'strong', children: [text('Worth')] },
      text(' a '),
      { type: 'em', children: [text('look')] },
      text(' '),
      { type: 'strike', children: [text('no')] },
      text(' '),
      { type: 'code', text: 'CI / check' },
    ]);
  });

  it('nests emphasis', () => {
    expect(parseInline('**bold *and em***')).toEqual([
      { type: 'strong', children: [text('bold '), { type: 'em', children: [text('and em')] }] },
    ]);
    expect(parseInline('*a **b** c*')).toEqual([
      { type: 'em', children: [text('a '), { type: 'strong', children: [text('b')] }, text(' c')] },
    ]);
  });

  it('leaves snake_case, lone stars and spaced delimiters alone', () => {
    expect(parseInline('file_name_here and 2 * 3 * 4 and ** not **')).toEqual([
      text('file_name_here and 2 * 3 * 4 and ** not **'),
    ]);
    expect(parseInline('_em_ works')).toEqual([{ type: 'em', children: [text('em')] }, text(' works')]);
  });

  it('does not format inside code, and code does not close emphasis', () => {
    expect(parseInline('`**x**` and `"q"`')).toEqual([
      { type: 'code', text: '**x**' },
      text(' and '),
      { type: 'code', text: '"q"' },
    ]);
    expect(parseInline('``a ` b``')).toEqual([{ type: 'code', text: 'a ` b' }]);
    expect(parseInline('an `unclosed tick')).toEqual([text('an `unclosed tick')]);
  });

  it('parses safe links and bare URLs, trimming sentence punctuation', () => {
    expect(parseInline('see [the PR](https://github.com/x/y/pull/1).')).toEqual([
      text('see '),
      { type: 'link', href: 'https://github.com/x/y/pull/1', children: [text('the PR')] },
      text('.'),
    ]);
    expect(parseInline('at https://whombat.com/docs, (https://x.io/a_(b)) ok')).toEqual([
      text('at '),
      { type: 'link', href: 'https://whombat.com/docs', children: [text('https://whombat.com/docs')] },
      text(', ('),
      { type: 'link', href: 'https://x.io/a_(b)', children: [text('https://x.io/a_(b)')] },
      text(') ok'),
    ]);
  });

  it('keeps parentheses inside a link target and never ends a link on a later line', () => {
    expect(parseInline('[Rust](https://en.wikipedia.org/wiki/Rust_(language)) is nice')).toEqual([
      {
        type: 'link',
        href: 'https://en.wikipedia.org/wiki/Rust_(language)',
        children: [text('Rust')],
      },
      text(' is nice'),
    ]);
    // The words on the next line are the person's, not part of a link nobody closed.
    expect(inlineText(parseInline('[a](https://x.io\nfoo) bar'))).toBe('[a](https://x.io\nfoo) bar');
  });

  it('refuses unsafe link targets', () => {
    expect(parseInline('[click](javascript:alert(1))')).toEqual([text('[click](javascript:alert(1))')]);
  });

  it('finds links after unmatched brackets without pairing labels across lines', () => {
    const prefix = '['.repeat(16_000);
    const link: Inline = { type: 'link', href: 'https://x.io', children: [text('ok')] };
    expect(parseInline(`${prefix}[ok](https://x.io)`)).toEqual([text(prefix), link]);
    expect(parseInline('[outer\n[ok](https://x.io)')).toEqual([text('[outer'), { type: 'break' }, link]);
    expect(parseInline('[outer [inner]](https://x.io)')).toEqual([
      { type: 'link', href: 'https://x.io', children: [text('outer [inner]')] },
    ]);
    expect(parseInline('![outer\n[ok](https://x.io)')).toEqual([text('![outer'), { type: 'break' }, link]);
  });

  it('keeps balanced URL parentheses while trimming long runs of sentence punctuation', () => {
    const url = 'https://x.io/a_(b)';
    const punctuation = '),'.repeat(8_000);
    expect(parseInline(`${url}${punctuation}`)).toEqual([
      { type: 'link', href: url, children: [text(url)] },
      text(punctuation),
    ]);
    expect(parseInline('https://x.io/a((b)).')).toEqual([
      { type: 'link', href: 'https://x.io/a((b))', children: [text('https://x.io/a((b))')] },
      text('.'),
    ]);
  });

  it('finds mentions but not e-mail addresses', () => {
    expect(parseInline('@Banjo mail lumio@Scan.nl')).toEqual([
      { type: 'mention', text: '@Banjo' },
      text(' mail lumio@Scan.nl'),
    ]);
  });

  it('turns newlines into breaks and honours escapes', () => {
    expect(parseInline('one\ntwo \\*not em\\*')).toEqual([
      text('one'),
      { type: 'break' },
      text('two *not em*'),
    ]);
  });
});

describe('parseMessage', () => {
  it('parses the inbox triage from the screenshot', () => {
    const blocks = parseMessage(
      [
        'Here’s today’s inbox (24 Sep), 7 unread:',
        '',
        '**Worth a look**',
        '- **Lumio sign-in alerts** — 3 notices',
        '- **CI failed on main** — `CI / check` with',
        '  4 annotations.',
        '',
        '**Noise**',
        '- Roddelpraat newsletter.',
        '',
        'Want me to archive the two promos?',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'paragraph',
      'list',
      'paragraph',
      'list',
      'paragraph',
    ]);
    const list = blocks[2] as Extract<Block, { type: 'list' }>;
    expect(list.items).toHaveLength(2);
    expect(list.items[1]).toEqual([
      para(
        { type: 'strong', children: [text('CI failed on main')] },
        text(' — '),
        { type: 'code', text: 'CI / check' },
        text(' with'),
        { type: 'break' },
        text('4 annotations.'),
      ),
    ]);
  });

  it('parses ordered lists with their start and nested lists', () => {
    const [list] = parseMessage('3. three\n4. four\n   - a\n   - b\n5. five');
    expect(list).toMatchObject({ type: 'list', ordered: true, start: 3 });
    const items = (list as Extract<Block, { type: 'list' }>).items;
    expect(items).toHaveLength(3);
    expect(items[1]?.[1]).toMatchObject({
      type: 'list',
      ordered: false,
      items: [[para(text('a'))], [para(text('b'))]],
    });
  });

  it('keeps a list together across blank lines', () => {
    const blocks = parseMessage('- one\n\n- two\n\nafter');
    expect(blocks.map((b) => b.type)).toEqual(['list', 'paragraph']);
    expect((blocks[0] as Extract<Block, { type: 'list' }>).items).toHaveLength(2);
  });

  it('handles long blank runs before list items, continuations and following paragraphs', () => {
    const gap = '\n'.repeat(16_000);
    expect(parseMessage(`- one${gap}  continued${gap}- two${gap}after`)).toEqual([
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [[para(text('one'), { type: 'break' }, text('continued'))], [para(text('two'))]],
      },
      para(text('after')),
    ]);
  });

  it('parses headings, quotes, rules and fenced code', () => {
    expect(
      parseMessage('## Summary ##\n> quoted *text*\n> more\n\n---\n```ts\nconst a = "x";\n\n**no**\n```'),
    ).toEqual([
      { type: 'heading', level: 2, children: [text('Summary')] },
      {
        type: 'quote',
        children: [
          para(text('quoted '), { type: 'em', children: [text('text')] }, { type: 'break' }, text('more')),
        ],
      },
      { type: 'rule' },
      { type: 'code', lang: 'ts', text: 'const a = "x";\n\n**no**' },
    ]);
  });

  it('keeps an unclosed code fence to the end', () => {
    expect(parseMessage('```\nline')).toEqual([{ type: 'code', lang: null, text: 'line' }]);
  });

  it('closes a fence only with the same marker and at least its opening length', () => {
    expect(parseMessage('````ts\n```\n~~~~\n  `````\nafter')).toEqual([
      { type: 'code', lang: 'ts', text: '```\n~~~~' },
      para(text('after')),
    ]);
    expect(parseMessage('~~~~text\n~~~\n```\n~~~~~\nafter')).toEqual([
      { type: 'code', lang: 'text', text: '~~~\n```' },
      para(text('after')),
    ]);
  });

  it('does not take #channel for a heading', () => {
    expect(parseMessage('#billing-v2 is quiet')).toEqual([para(text('#billing-v2 is quiet'))]);
  });
});

describe('images (CT-90)', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\n  <rect width="10" height="10"/>\n</svg>';

  it('parses ![alt](src) for http(s) and data: images, before links', () => {
    expect(parseInline(`see ![a “chart”](https://x.io/c_(1).png "title") and ![](${PNG})`)).toEqual([
      text('see '),
      { type: 'image', alt: 'a “chart”', src: 'https://x.io/c_(1).png' },
      text(' and '),
      { type: 'image', alt: '', src: PNG },
    ]);
    expect(parseInline('![x](<data:image/SVG+XML;charset=utf-8,%3Csvg%3E>)')).toEqual([
      { type: 'image', alt: 'x', src: 'data:image/SVG+XML;charset=utf-8,%3Csvg%3E' },
    ]);
  });

  it('keeps unsafe image sources as text', () => {
    for (const src of [
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/bmp;base64,Qk0=',
      '/x.png',
    ])
      expect(parseInline(`![x](${src})`)).toEqual([text(`![x](${src})`)]);
    // An image source that is not safe but a link target that is: a “!” and a link, as before.
    expect(parseInline('![mail](mailto:a@b.c)')).toEqual([
      text('!'),
      { type: 'link', href: 'mailto:a@b.c', children: [text('mail')] },
    ]);
    expect(parseInline('\\![x](https://x.io/a.png)')).toEqual([
      text('!'),
      { type: 'link', href: 'https://x.io/a.png', children: [text('x')] },
    ]);
  });

  it('shows an image inside a link as the link’s content', () => {
    expect(parseInline('[![CI](https://x.io/badge.svg)](https://x.io/ci)')).toEqual([
      {
        type: 'link',
        href: 'https://x.io/ci',
        children: [{ type: 'image', alt: 'CI', src: 'https://x.io/badge.svg' }],
      },
    ]);
  });

  it('takes an SVG document written as a paragraph for an svg code block', () => {
    expect(parseMessage(`Here’s the chart:\n<?xml version="1.0"?>\n${SVG}\nWhat do you think?`)).toEqual([
      para(text('Here’s the chart:')),
      { type: 'code', lang: 'svg', text: `<?xml version="1.0"?>\n${SVG}`, preview: 'svg' },
      para(text('What do you think?')),
    ]);
    // Blank lines and nested <svg> inside the document.
    const nested = '<svg viewBox="0 0 2 2">\n\n<svg x="1"><circle r="1"/></svg>\n<svg/>\n</svg>';
    expect(parseMessage(nested)).toEqual([{ type: 'code', lang: 'svg', text: nested, preview: 'svg' }]);
  });

  it('leaves an unclosed or trailing-text <svg> as text', () => {
    expect(parseMessage('<svg width="1">\nno end').map((b) => b.type)).toEqual(['paragraph']);
    expect(parseMessage('<svg></svg> and more').map((b) => b.type)).toEqual(['paragraph']);
    expect(parseMessage('<svgs are fun>')).toEqual([para(text('<svgs are fun>'))]);
  });

  it('gives a fenced SVG document the svg language', () => {
    const svg = { type: 'code', lang: 'svg', text: SVG, preview: 'svg' };
    expect(parseMessage(`\`\`\`xml\n${SVG}\n\`\`\``)).toEqual([svg]);
    expect(parseMessage(`\`\`\`\n${SVG}\n\`\`\``)).toEqual([svg]);
    expect(parseMessage(`\`\`\`html\n${SVG}\n\`\`\``)).toEqual([svg]);
    expect(parseMessage(`\`\`\`SVG\nnot svg\n\`\`\``)).toEqual([
      { type: 'code', lang: 'svg', text: 'not svg' },
    ]);
    expect(parseMessage('```html\n<div></div>\n```')).toEqual([
      { type: 'code', lang: 'html', text: '<div></div>', preview: 'html' },
    ]);
    expect(parseMessage(`\`\`\`ts\n${SVG}\n\`\`\``)).toEqual([{ type: 'code', lang: 'ts', text: SVG }]);
  });
});

describe('plainMessageText', () => {
  it('drops the formatting', () => {
    expect(plainMessageText('**Worth a look**\n- `CI` failed\n- [PR](https://x.io)\n\n1. one')).toBe(
      'Worth a look\n• CI failed\n• PR\n1. one',
    );
  });

  it('shows images as their alt text or [image]', () => {
    expect(plainMessageText('![Chart](https://x.io/a.png) ![](https://x.io/b.png)\n<svg><g/></svg>')).toBe(
      'Chart [image]\n[image]',
    );
  });
});

describe('smartQuotes', () => {
  it('curls apostrophes, openings and closings', () => {
    expect(smartQuotes(`'90s, it's "done" ('ok')`)).toBe('’90s, it’s “done” (‘ok’)');
  });
});
