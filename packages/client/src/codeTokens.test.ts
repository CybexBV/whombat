import { describe, expect, it } from 'vitest';
import {
  CODE_TOKEN_LINE_MAX,
  type CodeToken,
  codeLanguageOf,
  tokenizeCode,
  tokenizeCodeLine,
  tokenizeFileLines,
} from './codeTokens';

/** `[text, kind]` pairs of the coloured tokens of a line (plain text left out). */
const coloured = (tokens: readonly CodeToken[]) =>
  tokens.filter((t) => t.kind !== null).map((t) => [t.text, t.kind]);

/** The tokens put back together are the line, always. */
const joined = (tokens: readonly CodeToken[]) => tokens.map((t) => t.text).join('');

describe('code tokens (MX-06)', () => {
  it('knows a file’s language by its name, then its extension', () => {
    expect(codeLanguageOf('apps/web/src/main.tsx')).toBe('js');
    expect(codeLanguageOf('cmd/server/main.go')).toBe('go');
    expect(codeLanguageOf('src/lib.rs')).toBe('rust');
    expect(codeLanguageOf('scripts/deploy.sh')).toBe('shell');
    expect(codeLanguageOf('Dockerfile')).toBe('dockerfile');
    expect(codeLanguageOf('infra/web.Dockerfile')).toBe('dockerfile');
    expect(codeLanguageOf('Makefile')).toBe('shell');
    expect(codeLanguageOf('.env.local')).toBe('ini');
    expect(codeLanguageOf('pnpm-lock.yaml')).toBe('yaml');
    expect(codeLanguageOf('Cargo.toml')).toBe('ini');
    expect(codeLanguageOf('docs/README.md')).toBe('markdown');
    expect(codeLanguageOf('public/logo.svg')).toBe('markup');
    expect(codeLanguageOf('db/0084_indexes.sql')).toBe('sql');
    expect(codeLanguageOf('LICENSE')).toBeNull();
    expect(codeLanguageOf('photo.png')).toBeNull();
    expect(codeLanguageOf('trailing.')).toBeNull();
  });

  it('colours a TypeScript line: keywords, names, types, strings, numbers, comments', () => {
    const [tokens] = tokenizeCodeLine(
      "export async function load(id: string): Promise<Item> { return get('items', 42); } // done",
      'js',
    );
    expect(joined(tokens)).toBe(
      "export async function load(id: string): Promise<Item> { return get('items', 42); } // done",
    );
    expect(coloured(tokens)).toEqual([
      ['export', 'keyword'],
      ['async', 'keyword'],
      ['function', 'keyword'],
      ['load', 'title'],
      ['Promise', 'type'],
      ['Item', 'type'],
      ['return', 'keyword'],
      ['get', 'title'],
      ["'items'", 'string'],
      ['42', 'number'],
      ['// done', 'comment'],
    ]);
  });

  it('carries a block comment and a template literal over to the next lines', () => {
    const lines = tokenizeCode(['const a = 1; /* one', 'two', 'three */ const b = `x', 'y` + 2;'], 'js');
    expect(lines?.map(coloured)).toEqual([
      [
        ['const', 'keyword'],
        ['1', 'number'],
        ['/* one', 'comment'],
      ],
      [['two', 'comment']],
      [
        ['three */', 'comment'],
        ['const', 'keyword'],
        ['`x', 'string'],
      ],
      [
        ['y`', 'string'],
        ['2', 'number'],
      ],
    ]);
  });

  it('keeps a lone apostrophe plain (a Rust lifetime, prose in a comment-less line)', () => {
    const [tokens] = tokenizeCodeLine("fn first<'a>(x: &'a str) -> &'a str { x }", 'rust');
    expect(coloured(tokens)).toEqual([
      ['fn', 'keyword'],
      ['first', 'title'],
      ['str', 'keyword'],
      ['str', 'keyword'],
    ]);
  });

  it('reads Python decorators, definitions and triple-quoted strings', () => {
    const lines = tokenizeCode(
      ['@app.route("/")', 'def index():', '    """Home', '    page."""', '    return None'],
      'python',
    );
    expect(lines?.map(coloured)).toEqual([
      [
        ['@app.route', 'meta'],
        ['"/"', 'string'],
      ],
      [
        ['def', 'keyword'],
        ['index', 'title'],
      ],
      [['"""Home', 'string']],
      [['    page."""', 'string']],
      [
        ['return', 'keyword'],
        ['None', 'number'],
      ],
    ]);
  });

  it('reads shell: comments only after a space, variables, keywords', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell's own `${…}`, not a template
    const [tokens] = tokenizeCode(['if [ -n "$HOME" ]; then echo ${USER} $# # done; fi'], 'shell') ?? [[]];
    expect(coloured(tokens ?? [])).toEqual([
      ['if', 'keyword'],
      ['"$HOME"', 'string'],
      ['then', 'keyword'],
      ['echo', 'keyword'],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell's own `${…}`, not a template
      ['${USER}', 'attr'],
      ['$#', 'attr'],
      ['# done; fi', 'comment'],
    ]);
  });

  it('reads Dockerfile instructions', () => {
    const [tokens] = tokenizeCodeLine('FROM node:24-alpine AS build', 'dockerfile');
    expect(coloured(tokens)).toEqual([
      ['FROM', 'keyword'],
      ['24', 'number'],
      ['AS', 'keyword'],
    ]);
  });

  it('reads JSON keys apart from string values', () => {
    const [tokens] = tokenizeCodeLine('  "name": "whombat", "private": true, "port": 4400', 'json');
    expect(coloured(tokens)).toEqual([
      ['"name"', 'attr'],
      ['"whombat"', 'string'],
      ['"private"', 'attr'],
      ['true', 'number'],
      ['"port"', 'attr'],
      ['4400', 'number'],
    ]);
  });

  it('reads YAML keys, list items, values and comments', () => {
    const lines = tokenizeCode(
      ['---', 'jobs:', '  - name: "build" # first', '    retries: 3', '    url: https://x.y'],
      'yaml',
    );
    expect(lines?.map(coloured)).toEqual([
      [['---', 'meta']],
      [['jobs', 'attr']],
      [
        ['-', 'number'],
        ['name', 'attr'],
        ['"build"', 'string'],
        ['# first', 'comment'],
      ],
      [
        ['retries', 'attr'],
        ['3', 'number'],
      ],
      [['url', 'attr']],
    ]);
  });

  it('reads TOML/INI sections, keys and values', () => {
    const lines = tokenizeCode(['[package]', 'name = "app" # the name', 'export PORT=4400'], 'ini');
    expect(lines?.map(coloured)).toEqual([
      [['[package]', 'title']],
      [
        ['name', 'attr'],
        ['"app"', 'string'],
        ['# the name', 'comment'],
      ],
      [
        ['export ', 'keyword'],
        ['PORT', 'attr'],
        ['4400', 'number'],
      ],
    ]);
  });

  it('reads CSS selectors, at-rules, properties and colours', () => {
    const lines = tokenizeCode(
      ['@media (max-width: 600px) {', '.card:hover, a {', '  color: #fff;', '  margin: 0 4px; }'],
      'css',
    );
    expect(lines?.map(coloured)).toEqual([
      [
        ['@media', 'keyword'],
        ['600px', 'number'],
      ],
      [
        ['.card:hover', 'attr'],
        ['a', 'type'],
      ],
      [
        ['color', 'attr'],
        ['#fff', 'number'],
      ],
      [
        ['margin', 'attr'],
        ['0', 'number'],
        ['4px', 'number'],
      ],
    ]);
  });

  it('reads markup: tags, attributes over several lines, comments, doctype', () => {
    const lines = tokenizeCode(
      ['<!DOCTYPE html>', '<a href="/x"', "   class='b'>Go &amp; see</a> <!-- note", '-->'],
      'markup',
    );
    expect(lines?.map(coloured)).toEqual([
      [['<!DOCTYPE html>', 'meta']],
      [
        ['<a', 'tag'],
        ['href', 'attr'],
        ['"/x"', 'string'],
      ],
      [
        ['class', 'attr'],
        ["'b'", 'string'],
        ['>', 'tag'],
        ['&amp;', 'number'],
        ['</a>', 'tag'],
        ['<!-- note', 'comment'],
      ],
      [['-->', 'comment']],
    ]);
  });

  it('reads SQL keywords in any case', () => {
    const [tokens] = tokenizeCodeLine(
      "SELECT id FROM messages WHERE ord > 10 AND author = 'x'; -- recent",
      'sql',
    );
    expect(coloured(tokens)).toEqual([
      ['SELECT', 'keyword'],
      ['FROM', 'keyword'],
      ['WHERE', 'keyword'],
      ['10', 'number'],
      ['AND', 'keyword'],
      ["'x'", 'string'],
      ['-- recent', 'comment'],
    ]);
  });

  it('reads Markdown headings, lists, quotes, inline code and fences', () => {
    const lines = tokenizeCode(
      ['# Title', '- [x] run `pnpm check`', '> quoted', '```ts', 'const a = 1;', '```'],
      'markdown',
    );
    expect(lines?.map(coloured)).toEqual([
      [['# Title', 'title']],
      [
        ['-', 'number'],
        ['[x] ', 'number'],
        ['`pnpm check`', 'string'],
      ],
      [['> quoted', 'comment']],
      [['```ts', 'meta']],
      [['const a = 1;', 'string']],
      [['```', 'meta']],
    ]);
  });

  it('marks C preprocessor lines and Rust attributes as meta', () => {
    expect(coloured(tokenizeCodeLine('#include <stdio.h>', 'c')[0])).toEqual([
      ['#include <stdio.h>', 'meta'],
    ]);
    expect(coloured(tokenizeCodeLine('#[derive(Debug)]', 'rust')[0])).toEqual([['#[derive(Debug)]', 'meta']]);
  });

  it('leaves very long lines and unknown languages plain', () => {
    const long = 'a'.repeat(CODE_TOKEN_LINE_MAX + 1);
    expect(tokenizeCodeLine(long, 'js')[0]).toEqual([{ text: long, kind: null }]);
    expect(tokenizeCode(['x'], null)).toBeNull();
  });

  it('gives the file view tokens for the new file’s lines only, in their order', () => {
    const lines = [
      { kind: 'context' as const, text: 'const a = `one' },
      { kind: 'del' as const, text: 'old` + 1;' },
      { kind: 'add' as const, text: 'two`;' },
      { kind: 'context' as const, text: 'return a;' },
    ];
    const tokens = tokenizeFileLines(lines, 'src/a.ts');
    expect(tokens[1]).toBeNull();
    // The string opened on the first line closes on the added line (the removed one is not in the new file).
    expect(coloured(tokens[2] ?? [])).toEqual([['two`', 'string']]);
    expect(coloured(tokens[3] ?? [])).toEqual([['return', 'keyword']]);
    expect(tokenizeFileLines(lines, 'LICENSE')).toEqual([null, null, null, null]);
  });

  it('never loses or reorders text', () => {
    const samples: [string, Parameters<typeof tokenizeCodeLine>[1]][] = [
      ['let x = "a\\"b" + \'c\' // d', 'js'],
      ['  key: [1, 2, "three"]', 'yaml'],
      ['<x a="1" b>t</x>', 'markup'],
      ['echo "$(date)" > out.log', 'shell'],
      ['h1 { color: red }', 'css'],
    ];
    for (const [line, language] of samples) expect(joined(tokenizeCodeLine(line, language)[0])).toBe(line);
  });
});
