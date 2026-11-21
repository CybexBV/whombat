/**
 * Syntax colours for code read line by line (the phone's pull request file view, MX-06): a small, pure tokenizer —
 * no highlight.js, no DOM, no regular expressions beyond what every JavaScript engine (Hermes included) runs. It knows
 * the families most repositories are made of (C-like languages, Python, Ruby, shell, JSON, YAML, TOML/INI, CSS, HTML/XML,
 * SQL, Markdown, Dockerfiles) well enough to colour keywords, strings, numbers, comments, names, types, attributes, tags
 * and meta lines with the web's colour kinds (`codeColors.syntax*` in @whombat/tokens, AP-322). Lines are read in
 * order and a block comment, a multi-line string or an open tag carries over to the next line; anything it doesn't
 * know stays plain. The web's message code blocks keep highlight.js (lazy, DOM-free there too).
 */

/** The colour kinds of the web's highlighter (`codeColors.syntax*`), without the diff kinds. */
export type CodeTokenKind =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'title'
  | 'type'
  | 'attr'
  | 'tag'
  | 'meta';

export interface CodeToken {
  text: string;
  /** Null: plain text in the code colour. */
  kind: CodeTokenKind | null;
}

export type CodeLanguage =
  | 'js'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'php'
  | 'python'
  | 'ruby'
  | 'shell'
  | 'dockerfile'
  | 'sql'
  | 'json'
  | 'yaml'
  | 'ini'
  | 'css'
  | 'markup'
  | 'markdown';

/** Longest line coloured; longer ones (minified files) stay plain, so a file still opens at once. */
export const CODE_TOKEN_LINE_MAX = 2000;
/** Most lines coloured in one file; past it the rest stay plain. */
export const CODE_TOKEN_LINES_MAX = 20_000;

/* Which language ------------------------------------------------------------------------------------------------- */

const BY_EXTENSION: Record<string, CodeLanguage> = {
  ts: 'js',
  tsx: 'js',
  mts: 'js',
  cts: 'js',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'java',
  kts: 'java',
  scala: 'java',
  groovy: 'java',
  gradle: 'java',
  dart: 'java',
  cs: 'java',
  swift: 'java',
  c: 'c',
  h: 'c',
  cc: 'c',
  cpp: 'c',
  cxx: 'c',
  hpp: 'c',
  hh: 'c',
  m: 'c',
  mm: 'c',
  php: 'php',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  fish: 'shell',
  mk: 'shell',
  dockerfile: 'dockerfile',
  sql: 'sql',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  webmanifest: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  editorconfig: 'ini',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'markup',
  htm: 'markup',
  xhtml: 'markup',
  xml: 'markup',
  svg: 'markup',
  plist: 'markup',
  vue: 'markup',
  svelte: 'markup',
  astro: 'markup',
  csproj: 'markup',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
};

const BY_NAME: Record<string, CodeLanguage> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'shell',
  gnumakefile: 'shell',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.profile': 'shell',
  '.gitignore': 'shell',
  '.dockerignore': 'shell',
  codeowners: 'shell',
  gemfile: 'ruby',
  rakefile: 'ruby',
  jenkinsfile: 'java',
  '.npmrc': 'ini',
  '.editorconfig': 'ini',
};

/** The language a file's path names (its name, then its extension); null when it names none this knows. */
export function codeLanguageOf(path: string): CodeLanguage | null {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (!name) return null;
  const named = BY_NAME[name];
  if (named) return named;
  if (name === '.env' || name.startsWith('.env.')) return 'ini';
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  return BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

/* The generic lexer ---------------------------------------------------------------------------------------------- */

const words = (text: string) => new Set(text.split(/\s+/).filter(Boolean));

interface StringRule {
  open: string;
  close: string;
  /** A backslash escapes the next character. */
  escape: boolean;
  /** It may run over line ends (a template literal, a triple-quoted string). */
  multiline: boolean;
}

interface Grammar {
  lineComments: readonly string[];
  /** `#` starts a comment only at the line's start or after a space (shell: `$#`, `a#b` are not comments). */
  hashNeedsSpace?: boolean;
  blockComments: readonly (readonly [string, string])[];
  strings: readonly StringRule[];
  keywords: ReadonlySet<string>;
  literals: ReadonlySet<string>;
  /** Keywords match in any case (SQL, Dockerfile instructions). */
  caseInsensitive?: boolean;
  /** `Name` (capitalised, with a small letter) reads as a type. */
  capitalTypes?: boolean;
  /** `name(` reads as a function's name. */
  calls?: boolean;
  /** After these words the next name is a function's (`def`, `function`, `fn`). */
  titleAfter?: ReadonlySet<string>;
  /** After these words the next name is a type's (`class`, `struct`, `interface`). */
  typeAfter?: ReadonlySet<string>;
  /** `@decorator` / `@Annotation` reads as meta. */
  annotations?: boolean;
  /** `#include …`, `#[derive(…)]` read as meta. */
  hashMeta?: boolean;
  /** `$name`, `${…}` read as attributes (shell, PHP). */
  variables?: boolean;
  /** A string followed by `:` is a key (JSON). */
  stringKeys?: boolean;
  /** Names may contain `-` (CSS properties, shell words). */
  dashedNames?: boolean;
  /** Characters a name may end with (Ruby's `empty?`, `save!`). */
  nameSuffixes?: string;
  /** `#fff`, `#a1b2c3` read as numbers (CSS colours). */
  hexColours?: boolean;
}

const DOUBLE: StringRule = { open: '"', close: '"', escape: true, multiline: false };
const SINGLE: StringRule = { open: "'", close: "'", escape: true, multiline: false };
const BACKTICK: StringRule = { open: '`', close: '`', escape: true, multiline: true };

const C_LITERALS = words('true false null undefined nil NaN Infinity None True False');

const JS_KEYWORDS = words(`
  abstract as async await break case catch class const continue debugger declare default delete do else enum export
  extends finally for from function if implements import in instanceof interface is keyof let namespace new of
  override package private protected public readonly return satisfies static switch throw try type typeof var void
  while with yield`);
const GO_KEYWORDS = words(`
  break case chan const continue default defer else fallthrough for func go goto if import interface map package range
  return select struct switch type var any bool byte complex128 complex64 error float32 float64 int int16 int32 int64
  int8 rune string uint uint16 uint32 uint64 uint8 uintptr append cap close copy delete len make new panic print println
  recover iota`);
const RUST_KEYWORDS = words(`
  as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref
  return static struct trait type unsafe use where while Self bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32
  u64 u128 usize Some Ok Err macro_rules`);
const JAVA_KEYWORDS = words(`
  abstract assert boolean break byte case catch char class const continue default do double else enum extends final
  finally float for goto if implements import instanceof int interface long native new package private protected public
  return short static strictfp switch synchronized throw throws transient try void volatile while var val fun object
  companion data sealed when is in out override open internal lateinit by init suspend inline reified typealias where
  def trait yield lazy implicit match using namespace readonly sealed struct async await get set let guard func protocol
  extension import required late dynamic mixin library part show hide`);
const C_KEYWORDS = words(`
  auto break case char const continue default do double else enum extern float for goto if inline int long register
  restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool class
  namespace template typename public private protected virtual override final friend operator new delete try catch throw
  using constexpr nullptr noexcept static_cast dynamic_cast reinterpret_cast const_cast decltype explicit mutable
  this std size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t`);
const PHP_KEYWORDS = words(`
  abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty
  enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if
  implements include include_once instanceof insteadof interface isset list match namespace new or print private
  protected public readonly require require_once return static switch throw trait try unset use var while xor yield`);
const PYTHON_KEYWORDS = words(`
  and as assert async await break class continue def del elif else except finally for from global if import in is
  lambda nonlocal not or pass raise return try while with yield match case print len range`);
const RUBY_KEYWORDS = words(`
  alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry
  return self super then undef unless until when while yield require require_relative attr_reader attr_writer
  attr_accessor private protected public puts lambda proc`);
const SHELL_KEYWORDS = words(`
  if then else elif fi for while until do done case esac in function select time return exit export local readonly
  declare unset shift source alias echo cd set trap eval exec`);
const DOCKER_KEYWORDS = words(`
  FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK
  SHELL AS`);
const SQL_KEYWORDS = words(`
  select from where and or not insert into values update set delete create table alter drop index view on join left
  right inner outer full cross group by order having limit offset as distinct union all exists in is like between case
  when then else end primary key foreign references unique default check constraint if begin commit rollback
  transaction returning with recursive cascade grant revoke trigger function procedure language replace column add
  rename to using asc desc nulls first last integer int bigint smallint text varchar char boolean timestamp timestamptz
  date time jsonb json uuid serial bigserial numeric decimal real double precision bytea`);

const C_LIKE = {
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  literals: C_LITERALS,
  capitalTypes: true,
  calls: true,
  annotations: true,
} as const;

const GRAMMARS: Record<Exclude<CodeLanguage, 'yaml' | 'ini' | 'css' | 'markup' | 'markdown'>, Grammar> = {
  js: {
    ...C_LIKE,
    strings: [DOUBLE, SINGLE, BACKTICK],
    keywords: JS_KEYWORDS,
    titleAfter: words('function'),
    typeAfter: words('class interface type enum extends implements new'),
  },
  go: {
    ...C_LIKE,
    strings: [DOUBLE, { open: '`', close: '`', escape: false, multiline: true }, SINGLE],
    keywords: GO_KEYWORDS,
    titleAfter: words('func'),
    typeAfter: words('type struct interface'),
    annotations: false,
  },
  rust: {
    ...C_LIKE,
    strings: [DOUBLE],
    keywords: RUST_KEYWORDS,
    titleAfter: words('fn'),
    typeAfter: words('struct enum trait impl type for'),
    annotations: false,
    hashMeta: true,
  },
  java: {
    ...C_LIKE,
    strings: [{ open: '"""', close: '"""', escape: true, multiline: true }, DOUBLE, SINGLE],
    keywords: JAVA_KEYWORDS,
    titleAfter: words('fun def func'),
    typeAfter: words(
      'class interface enum object struct protocol extension trait extends implements new record',
    ),
  },
  c: {
    ...C_LIKE,
    strings: [DOUBLE, SINGLE],
    keywords: C_KEYWORDS,
    typeAfter: words('struct class enum union typedef namespace'),
    annotations: false,
    hashMeta: true,
  },
  php: {
    ...C_LIKE,
    lineComments: ['//', '#'],
    strings: [DOUBLE, SINGLE],
    keywords: PHP_KEYWORDS,
    caseInsensitive: true,
    titleAfter: words('function fn'),
    typeAfter: words('class interface trait enum extends implements new'),
    variables: true,
  },
  python: {
    lineComments: ['#'],
    blockComments: [],
    strings: [
      { open: '"""', close: '"""', escape: true, multiline: true },
      { open: "'''", close: "'''", escape: true, multiline: true },
      DOUBLE,
      SINGLE,
    ],
    keywords: PYTHON_KEYWORDS,
    literals: words('True False None'),
    capitalTypes: true,
    calls: true,
    titleAfter: words('def'),
    typeAfter: words('class'),
    annotations: true,
  },
  ruby: {
    lineComments: ['#'],
    blockComments: [['=begin', '=end']],
    strings: [DOUBLE, SINGLE],
    keywords: RUBY_KEYWORDS,
    literals: words('true false nil'),
    capitalTypes: true,
    titleAfter: words('def'),
    typeAfter: words('class module'),
    nameSuffixes: '?!',
  },
  shell: {
    lineComments: ['#'],
    hashNeedsSpace: true,
    blockComments: [],
    strings: [
      { open: '"', close: '"', escape: true, multiline: true },
      { open: "'", close: "'", escape: false, multiline: true },
    ],
    keywords: SHELL_KEYWORDS,
    literals: words('true false'),
    variables: true,
    dashedNames: true,
  },
  dockerfile: {
    lineComments: ['#'],
    hashNeedsSpace: true,
    blockComments: [],
    strings: [DOUBLE, { open: "'", close: "'", escape: false, multiline: false }],
    keywords: new Set([...DOCKER_KEYWORDS, ...SHELL_KEYWORDS]),
    literals: words('true false'),
    variables: true,
    dashedNames: true,
  },
  sql: {
    lineComments: ['--'],
    blockComments: [['/*', '*/']],
    strings: [
      { open: "'", close: "'", escape: false, multiline: true },
      { open: '"', close: '"', escape: false, multiline: false },
    ],
    keywords: SQL_KEYWORDS,
    literals: words('true false null'),
    caseInsensitive: true,
  },
  json: {
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [DOUBLE],
    keywords: new Set(),
    literals: words('true false null'),
    stringKeys: true,
  },
};

/** What carries over from one line to the next. */
export type CodeTokenState =
  | null
  /** Inside a block comment or a multi-line string until `close`. */
  | { kind: 'comment' | 'string'; close: string; escape: boolean }
  /** Markup: inside a tag's attributes (they may continue on the next line). */
  | { kind: 'tag' }
  /** Markdown: inside a fenced code block. */
  | { kind: 'fence'; fence: string };

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isNameStart = (c: string | undefined) =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$');
const isNameChar = (c: string | undefined, dashed = false) =>
  isNameStart(c) || isDigit(c) || (dashed && c === '-');
const isSpace = (c: string | undefined) => c === ' ' || c === '\t';

/** Builds the tokens of one line, merging neighbours of the same kind. */
class Line {
  readonly tokens: CodeToken[] = [];
  push(text: string, kind: CodeTokenKind | null): void {
    if (!text) return;
    const last = this.tokens.at(-1);
    if (last && last.kind === kind) last.text += text;
    else this.tokens.push({ text, kind });
  }
}

/** Where a string that opened before `from` closes: the index after its close, or -1 when it runs past the line. */
function closeOf(text: string, from: number, close: string, escapes: boolean): number {
  for (let i = from; i < text.length; i++) {
    if (escapes && text[i] === '\\') {
      i++;
      continue;
    }
    if (text.startsWith(close, i)) return i + close.length;
  }
  return -1;
}

/** A number at `i`: `42`, `3.14`, `1e-9`, `0xff`, `1_000`, `10px`, `2n`; its end. */
function numberEnd(text: string, i: number): number {
  let j = i;
  if (
    text[j] === '0' &&
    (text[j + 1] === 'x' || text[j + 1] === 'X' || text[j + 1] === 'b' || text[j + 1] === 'o')
  ) {
    j += 2;
    while (isNameChar(text[j])) j++;
    return j;
  }
  while (isDigit(text[j]) || text[j] === '_') j++;
  if (text[j] === '.' && isDigit(text[j + 1])) {
    j++;
    while (isDigit(text[j]) || text[j] === '_') j++;
  }
  if (
    (text[j] === 'e' || text[j] === 'E') &&
    (isDigit(text[j + 1]) || text[j + 1] === '-' || text[j + 1] === '+')
  ) {
    j += 2;
    while (isDigit(text[j])) j++;
  }
  // A unit or suffix (`px`, `ms`, `u32`, `n`, `f`, `%`).
  while (isNameChar(text[j]) || text[j] === '%') j++;
  return j;
}

function nextNonSpace(text: string, i: number): string | undefined {
  let j = i;
  while (isSpace(text[j])) j++;
  return text[j];
}

function lexGeneric(text: string, g: Grammar, state: CodeTokenState): [CodeToken[], CodeTokenState] {
  const line = new Line();
  let i = 0;
  if (state && (state.kind === 'comment' || state.kind === 'string')) {
    const end = closeOf(text, 0, state.close, state.escape);
    if (end < 0) {
      line.push(text, state.kind);
      return [line.tokens, state];
    }
    line.push(text.slice(0, end), state.kind);
    i = end;
  }
  let previousWord = '';
  // A preprocessor line (`#include <x>`, `#define`) or an attribute (`#[derive(Debug)]`).
  if (g.hashMeta) {
    const start = text.length - text.trimStart().length;
    if (i === 0 && text[start] === '#') {
      line.push(text.slice(0, start), null);
      line.push(text.slice(start), 'meta');
      return [line.tokens, null];
    }
  }
  while (i < text.length) {
    const c = text[i] as string;
    // Line comments.
    const lineComment = g.lineComments.find((p) => text.startsWith(p, i));
    if (lineComment && (!g.hashNeedsSpace || lineComment !== '#' || i === 0 || isSpace(text[i - 1]))) {
      line.push(text.slice(i), 'comment');
      return [line.tokens, null];
    }
    // Block comments.
    const block = g.blockComments.find(([open]) => text.startsWith(open, i));
    if (block) {
      const end = closeOf(text, i + block[0].length, block[1], false);
      if (end < 0) {
        line.push(text.slice(i), 'comment');
        return [line.tokens, { kind: 'comment', close: block[1], escape: false }];
      }
      line.push(text.slice(i, end), 'comment');
      i = end;
      continue;
    }
    // Strings (the longest opening first: `"""` before `"`).
    const rule = g.strings.find((s) => text.startsWith(s.open, i));
    if (rule) {
      const end = closeOf(text, i + rule.open.length, rule.close, rule.escape);
      if (end < 0) {
        // A lone `'` (a Rust lifetime, an apostrophe in prose) that never closes is not a string.
        if (!rule.multiline && rule.open === "'") {
          line.push(c, null);
          i++;
          continue;
        }
        line.push(text.slice(i), 'string');
        return [
          line.tokens,
          rule.multiline ? { kind: 'string', close: rule.close, escape: rule.escape } : null,
        ];
      }
      const key = g.stringKeys && nextNonSpace(text, end) === ':';
      line.push(text.slice(i, end), key ? 'attr' : 'string');
      i = end;
      continue;
    }
    // `@decorator`, `@Override`.
    if (g.annotations && c === '@' && isNameStart(text[i + 1])) {
      let j = i + 1;
      while (isNameChar(text[j]) || text[j] === '.') j++;
      line.push(text.slice(i, j), 'meta');
      i = j;
      continue;
    }
    // `$HOME`, `${name}`, `$1`, `$this`.
    if (g.variables && c === '$') {
      if (text[i + 1] === '{') {
        const end = text.indexOf('}', i + 2);
        const j = end < 0 ? text.length : end + 1;
        line.push(text.slice(i, j), 'attr');
        i = j;
        continue;
      }
      if (isNameChar(text[i + 1]) || text[i + 1] === '@' || text[i + 1] === '#' || text[i + 1] === '?') {
        let j = i + 2;
        while (isNameChar(text[j])) j++;
        line.push(text.slice(i, j), 'attr');
        i = j;
        continue;
      }
    }
    // `#fff` colours (CSS).
    if (g.hexColours && c === '#') {
      const m = /^#[0-9a-fA-F]{3,8}(?![\w-])/.exec(text.slice(i, i + 10));
      if (m) {
        line.push(m[0], 'number');
        i += m[0].length;
        continue;
      }
    }
    // Numbers (not the digits inside a name like `utf8` or `x2`).
    if (isDigit(c) && !isNameChar(text[i - 1])) {
      const j = numberEnd(text, i);
      line.push(text.slice(i, j), 'number');
      i = j;
      continue;
    }
    // Names: keywords, literals, functions, types.
    if (isNameStart(c)) {
      let j = i + 1;
      while (isNameChar(text[j], g.dashedNames)) j++;
      if (g.nameSuffixes && text[j] !== undefined && g.nameSuffixes.includes(text[j] as string)) j++;
      const word = text.slice(i, j);
      const key = g.caseInsensitive ? word.toLowerCase() : word;
      let kind: CodeTokenKind | null = null;
      if (g.keywords.has(key)) kind = 'keyword';
      else if (g.literals.has(word)) kind = 'number';
      else if (g.titleAfter?.has(previousWord)) kind = 'title';
      else if (g.typeAfter?.has(previousWord)) kind = 'type';
      else if (g.capitalTypes && /^[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$/.test(word)) kind = 'type';
      else if (g.calls && nextNonSpace(text, j) === '(') kind = 'title';
      line.push(word, kind);
      previousWord = word;
      i = j;
      continue;
    }
    // Punctuation ends what a `def`/`class` before it names (`function(a)` names no function `a`).
    if (!isSpace(c)) previousWord = '';
    line.push(c, null);
    i++;
  }
  return [line.tokens, null];
}

/* YAML, TOML/INI, CSS, markup, Markdown ------------------------------------------------------------------------- */

const YAML_LITERALS = words('true false null yes no on off True False Null TRUE FALSE NULL ~');
const YAML_VALUE: Grammar = {
  lineComments: ['#'],
  hashNeedsSpace: true,
  blockComments: [],
  strings: [DOUBLE, { open: "'", close: "'", escape: false, multiline: false }],
  keywords: new Set(),
  literals: YAML_LITERALS,
};

function lexYaml(text: string): CodeToken[] {
  const line = new Line();
  const trimmed = text.trimStart();
  const indent = text.slice(0, text.length - trimmed.length);
  if (trimmed === '---' || trimmed === '...') {
    line.push(indent, null);
    line.push(trimmed, 'meta');
    return line.tokens;
  }
  if (trimmed.startsWith('#')) {
    line.push(indent, null);
    line.push(trimmed, 'comment');
    return line.tokens;
  }
  let rest = trimmed;
  line.push(indent, null);
  // List items: `- `.
  while (rest.startsWith('- ') || rest === '-') {
    line.push('-', 'number');
    const after = rest.slice(1);
    const spaces = after.length - after.trimStart().length;
    line.push(after.slice(0, spaces), null);
    rest = after.slice(spaces);
  }
  // `key:` (a bare or quoted key, followed by a colon and a space or the line's end).
  const m = /^("[^"]*"|'[^']*'|[^\s:#'"][^:#]*?)(\s*:)(\s|$)/.exec(rest);
  if (m) {
    const key = m[1] as string;
    line.push(key, 'attr');
    line.push(m[2] as string, null);
    rest = rest.slice(key.length + (m[2] as string).length);
  }
  for (const t of lexGeneric(rest, YAML_VALUE, null)[0]) line.push(t.text, t.kind);
  return line.tokens;
}

const INI_VALUE: Grammar = {
  lineComments: ['#', ';'],
  hashNeedsSpace: true,
  blockComments: [],
  strings: [
    { open: '"""', close: '"""', escape: true, multiline: true },
    DOUBLE,
    { open: "'", close: "'", escape: false, multiline: false },
  ],
  keywords: new Set(),
  literals: words('true false yes no on off'),
};

function lexIni(text: string, state: CodeTokenState): [CodeToken[], CodeTokenState] {
  if (state) return lexGeneric(text, INI_VALUE, state);
  const line = new Line();
  const trimmed = text.trimStart();
  const indent = text.slice(0, text.length - trimmed.length);
  line.push(indent, null);
  if (trimmed.startsWith('#') || trimmed.startsWith(';')) {
    line.push(trimmed, 'comment');
    return [line.tokens, null];
  }
  if (trimmed.startsWith('[')) {
    const end = trimmed.lastIndexOf(']');
    const head = end < 0 ? trimmed : trimmed.slice(0, end + 1);
    line.push(head, 'title');
    const [rest] = lexGeneric(trimmed.slice(head.length), INI_VALUE, null);
    for (const t of rest) line.push(t.text, t.kind);
    return [line.tokens, null];
  }
  const m = /^(export\s+)?([^\s=:]+)(\s*[=:])/.exec(trimmed);
  let rest = trimmed;
  if (m) {
    if (m[1]) line.push(m[1], 'keyword');
    line.push(m[2] as string, 'attr');
    line.push(m[3] as string, null);
    rest = trimmed.slice(m[0].length);
  }
  const [tokens, next] = lexGeneric(rest, INI_VALUE, null);
  for (const t of tokens) line.push(t.text, t.kind);
  return [line.tokens, next];
}

const CSS_VALUE: Grammar = {
  lineComments: [],
  blockComments: [['/*', '*/']],
  strings: [DOUBLE, SINGLE],
  keywords: words('important inherit initial unset auto none'),
  literals: new Set(),
  dashedNames: true,
  hexColours: true,
};

function lexCss(text: string, state: CodeTokenState, scss: boolean): [CodeToken[], CodeTokenState] {
  const grammar: Grammar = scss ? { ...CSS_VALUE, lineComments: ['//'] } : CSS_VALUE;
  if (state) return lexGeneric(text, grammar, state);
  const line = new Line();
  const trimmed = text.trimStart();
  const indent = text.slice(0, text.length - trimmed.length);
  line.push(indent, null);
  // `@media …`, `@import …`.
  if (trimmed.startsWith('@')) {
    let j = 1;
    while (isNameChar(trimmed[j], true)) j++;
    line.push(trimmed.slice(0, j), 'keyword');
    const [rest, next] = lexGeneric(trimmed.slice(j), grammar, null);
    for (const t of rest) line.push(t.text, t.kind);
    return [line.tokens, next];
  }
  // `property: value;` (not a selector with a pseudo-class: those end with `{` or `,`).
  const decl = /^(--[\w-]+|-?[a-zA-Z][\w-]*)(\s*:)(?!:)/.exec(trimmed);
  const selector = /[{,]\s*$/.test(trimmed) || !trimmed.includes(':');
  if (decl && !selector) {
    line.push(decl[1] as string, 'attr');
    line.push(decl[2] as string, null);
    const [tokens, next] = lexGeneric(trimmed.slice(decl[0].length), grammar, null);
    for (const t of tokens) line.push(t.text, t.kind);
    return [line.tokens, next];
  }
  // A selector line: `.class`, `#id`, `:hover` as attributes, element names as types.
  let i = 0;
  while (i < trimmed.length) {
    const c = trimmed[i] as string;
    if (trimmed.startsWith('/*', i)) {
      const [rest, next] = lexGeneric(trimmed.slice(i), grammar, null);
      for (const t of rest) line.push(t.text, t.kind);
      return [line.tokens, next];
    }
    if ((c === '.' || c === '#' || c === ':' || c === '&') && isNameChar(trimmed[i + 1], true)) {
      let j = i + 1;
      while (isNameChar(trimmed[j], true)) j++;
      line.push(trimmed.slice(i, j), 'attr');
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (isNameChar(trimmed[j], true)) j++;
      line.push(trimmed.slice(i, j), 'type');
      i = j;
      continue;
    }
    line.push(c, null);
    i++;
  }
  return [line.tokens, null];
}

function lexMarkup(text: string, state: CodeTokenState): [CodeToken[], CodeTokenState] {
  const line = new Line();
  let i = 0;
  let inTag = state?.kind === 'tag';
  if (state?.kind === 'comment') {
    const end = closeOf(text, 0, '-->', false);
    if (end < 0) return [[{ text, kind: 'comment' }], state];
    line.push(text.slice(0, end), 'comment');
    i = end;
  }
  while (i < text.length) {
    const c = text[i] as string;
    if (inTag) {
      if (c === '>' || (c === '/' && text[i + 1] === '>')) {
        const j = c === '/' ? i + 2 : i + 1;
        line.push(text.slice(i, j), 'tag');
        i = j;
        inTag = false;
        continue;
      }
      if (c === '"' || c === "'") {
        const end = closeOf(text, i + 1, c, false);
        const j = end < 0 ? text.length : end;
        line.push(text.slice(i, j), 'string');
        i = j;
        continue;
      }
      if (isNameStart(c) || c === ':' || c === '@') {
        let j = i + 1;
        while (isNameChar(text[j], true) || text[j] === ':' || text[j] === '.') j++;
        line.push(text.slice(i, j), 'attr');
        i = j;
        continue;
      }
      line.push(c, null);
      i++;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const end = closeOf(text, i + 4, '-->', false);
      if (end < 0) {
        line.push(text.slice(i), 'comment');
        return [line.tokens, { kind: 'comment', close: '-->', escape: false }];
      }
      line.push(text.slice(i, end), 'comment');
      i = end;
      continue;
    }
    if (text.startsWith('<!', i) || text.startsWith('<?', i)) {
      const end = text.indexOf('>', i);
      const j = end < 0 ? text.length : end + 1;
      line.push(text.slice(i, j), 'meta');
      i = j;
      continue;
    }
    if (c === '<' && (isNameStart(text[i + 1]) || text[i + 1] === '/')) {
      let j = text[i + 1] === '/' ? i + 2 : i + 1;
      while (isNameChar(text[j], true) || text[j] === ':' || text[j] === '.') j++;
      line.push(text.slice(i, j), 'tag');
      i = j;
      inTag = true;
      continue;
    }
    // `&amp;` entities.
    if (c === '&') {
      const end = text.indexOf(';', i);
      if (end > i && end - i <= 10 && /^&#?\w+;$/.test(text.slice(i, end + 1))) {
        line.push(text.slice(i, end + 1), 'number');
        i = end + 1;
        continue;
      }
    }
    line.push(c, null);
    i++;
  }
  return [line.tokens, inTag ? { kind: 'tag' } : null];
}

function lexMarkdown(text: string, state: CodeTokenState): [CodeToken[], CodeTokenState] {
  const trimmed = text.trimStart();
  const fence = /^(```+|~~~+)/.exec(trimmed)?.[1];
  if (state?.kind === 'fence') {
    if (fence && fence[0] === state.fence[0] && fence.length >= state.fence.length)
      return [[{ text, kind: 'meta' }], null];
    return [[{ text, kind: 'string' }], state];
  }
  if (fence) return [[{ text, kind: 'meta' }], { kind: 'fence', fence }];
  const line = new Line();
  const indent = text.slice(0, text.length - trimmed.length);
  if (/^#{1,6}(\s|$)/.test(trimmed)) {
    line.push(indent, null);
    line.push(trimmed, 'title');
    return [line.tokens, null];
  }
  if (trimmed.startsWith('>')) {
    line.push(indent, null);
    line.push(trimmed, 'comment');
    return [line.tokens, null];
  }
  line.push(indent, null);
  let rest = trimmed;
  const marker = /^([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s)?/.exec(rest);
  if (marker) {
    line.push(`${marker[1]}`, 'number');
    line.push(marker[2] as string, null);
    if (marker[3]) line.push(marker[3], 'number');
    rest = rest.slice(marker[0].length);
  }
  // Inline code, links' addresses.
  let i = 0;
  while (i < rest.length) {
    const c = rest[i] as string;
    if (c === '`') {
      const end = rest.indexOf('`', i + 1);
      if (end > i) {
        line.push(rest.slice(i, end + 1), 'string');
        i = end + 1;
        continue;
      }
    }
    if (c === ']' && rest[i + 1] === '(') {
      const end = rest.indexOf(')', i + 2);
      if (end > i) {
        line.push(']', null);
        line.push(rest.slice(i + 1, end + 1), 'string');
        i = end + 1;
        continue;
      }
    }
    line.push(c, null);
    i++;
  }
  return [line.tokens, null];
}

/* Public --------------------------------------------------------------------------------------------------------- */

/** One line's tokens, given what the lines before it left open; returns the state for the next line. */
export function tokenizeCodeLine(
  text: string,
  language: CodeLanguage,
  state: CodeTokenState = null,
  options: { scss?: boolean } = {},
): [CodeToken[], CodeTokenState] {
  if (text.length > CODE_TOKEN_LINE_MAX) return [[{ text, kind: null }], state];
  switch (language) {
    case 'yaml':
      return [lexYaml(text), null];
    case 'ini':
      return lexIni(text, state);
    case 'css':
      return lexCss(text, state, options.scss === true);
    case 'markup':
      return lexMarkup(text, state);
    case 'markdown':
      return lexMarkdown(text, state);
    default:
      return lexGeneric(text, GRAMMARS[language], state);
  }
}

/**
 * Every line's tokens, in order (what one line leaves open carries to the next). Null without a language (plain
 * text); past `CODE_TOKEN_LINES_MAX` the remaining lines are plain.
 */
export function tokenizeCode(lines: readonly string[], language: CodeLanguage | null): CodeToken[][] | null {
  if (!language) return null;
  let state: CodeTokenState = null;
  return lines.map((text, n) => {
    if (n >= CODE_TOKEN_LINES_MAX) return [{ text, kind: null }];
    const [tokens, next] = tokenizeCodeLine(text, language, state);
    state = next;
    return tokens;
  });
}

/**
 * A file's lines as the pull request file view shows them (old and new interleaved, `del` lines from the old file):
 * tokens for the lines of the new file (context and added lines, read in order so a comment or string opened on one
 * carries to the next), null for removed lines and for a file in a language this doesn't know. Changed lines keep
 * their plain green or red (AP-664); the screen colours only the unchanged ones.
 */
export function tokenizeFileLines(
  lines: readonly { kind: 'add' | 'del' | 'context'; text: string }[],
  path: string,
): (CodeToken[] | null)[] {
  const language = codeLanguageOf(path);
  if (!language) return lines.map(() => null);
  const scss = /\.(scss|less)$/i.test(path);
  let state: CodeTokenState = null;
  let seen = 0;
  return lines.map((line) => {
    if (line.kind === 'del') return null;
    if (seen++ >= CODE_TOKEN_LINES_MAX) return null;
    const [tokens, next] = tokenizeCodeLine(line.text, language, state, { scss });
    state = next;
    return tokens;
  });
}
