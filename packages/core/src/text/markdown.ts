/**
 * Message formatting: the light Markdown people and agents write in chat, parsed into a small tree that
 * web and mobile render the same way (docs/decisions/rich-messages.md, contracts CT-149). Pure and forgiving:
 * anything it does not understand stays text. Chat semantics, not CommonMark: a single newline is a line break, a
 * list may start right under a line of text, and so may a table.
 *
 * Supported: paragraphs, `#`…`######` headings (with their `level`), `-`/`*`/`+` and `1.` lists (nested by
 * indentation) with GitHub task items (`- [ ]`, `- [x]`), `>` quotes (nested with `> >` or `>>`), GitHub tables
 * (a header row, a `| --- | :-: |` delimiter row with alignment, then rows), fenced code blocks with their language,
 * `---` rules; inline `**bold**`, `*italic*` / `_italic_`, `~~strike~~`, `` `code` ``, `[text](https://…)`, bare
 * `https://…` links, `@Name` mentions and `![alt](src)` images (CT-90: `https://`, `http://` or a `data:` PNG, JPEG,
 * GIF, WebP, AVIF or SVG; any other source stays text).
 *
 * Code blocks a client may show as more than code carry `preview` (CT-149):
 * - `svg`: an SVG document, written as a paragraph of its own (`<svg …>…</svg>`, optionally after an `<?xml …?>`
 *   prolog) or fenced in `svg`, `xml`, `html` or no language (then `lang` is `svg`); shown through `<img>` with
 *   {@link svgImageSrc}, never as DOM (CT-90);
 * - `html`: a fenced `html`/`htm`/`xhtml` block holding a page or a fragment that is not just an SVG, a fence without a
 *   language holding a page, or a raw paragraph from `<!DOCTYPE html` or `<html` to the line ending in `</html>` (blank
 *   lines included; `lang` is `html`); shown as a preview card in a sandboxed frame (`html.ts`);
 * - `mermaid`: a fenced `mermaid` block; rendered as a diagram in the same kind of sandbox.
 * No other HTML. Straight quotes in text become curly (’ “ ”), never inside code or links. The output is plain data
 * in document order, the same for the same text, so clients may key rendered blocks by position.
 */

import { HTML_PREVIEW_MAX, htmlTitle, isHtmlDocument, isHtmlPreviewable } from './html.js';
import { isSafeImageSrc, isSvgDocument, SVG_IMAGE_MAX, svgImageSrc } from './images.js';

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'mention'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'strike'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  /** `![alt](src)`; `src` passed {@link isSafeImageSrc}. */
  | { type: 'image'; alt: string; src: string }
  | { type: 'break' };

export interface ListBlock {
  type: 'list';
  ordered: boolean;
  /** First number of an ordered list. */
  start: number;
  /** Each item: its text, then any nested lists. */
  items: Block[][];
  /**
   * Task items (CT-149), present only when at least one item is one: per item, `true` for `[x]`, `false` for `[ ]`,
   * null for an ordinary item. Clients show read-only checkboxes; the `[ ]` marker is not in the item's text.
   */
  checked?: (boolean | null)[];
}

/** A heading's level, 1 for `#` to 6 for `######`. */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** A table column's alignment from its delimiter cell: `:--` left, `:-:` center, `--:` right, `---` none. */
export type TableAlign = 'left' | 'center' | 'right' | null;

/**
 * A GitHub table (CT-149). `align` and `header` have one entry per column; every row has exactly that many cells
 * (missing cells are empty, extra cells dropped). Each cell is an inline run.
 */
export interface TableBlock {
  type: 'table';
  align: TableAlign[];
  header: Inline[][];
  rows: Inline[][][];
}

/** How a client may show a code block besides its code (CT-149): see {@link codePreview}. */
export type CodePreview = 'svg' | 'html' | 'mermaid';

export interface CodeBlock {
  type: 'code';
  /** As written after the fence (`ts`, `HTML`), `svg` for an SVG document and `html` for a raw HTML page; or null. */
  lang: string | null;
  text: string;
  /** Present only when the block can be previewed (CT-149). */
  preview?: CodePreview;
}

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: HeadingLevel; children: Inline[] }
  | ListBlock
  | { type: 'quote'; children: Block[] }
  | TableBlock
  | CodeBlock
  | { type: 'rule' };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( *)([-*+•]|\d{1,9}[.)])[ \t]+(.*)$/;
const TASK = /^\[([ xX])\](?:[ \t]+([\s\S]*))?$/;

interface ItemLine {
  indent: number;
  ordered: boolean;
  n: number;
  text: string;
}

function itemLine(line: string): ItemLine | null {
  const m = ITEM.exec(line);
  if (!m) return null;
  const marker = m[2] as string;
  const ordered = /\d/.test(marker);
  return {
    indent: (m[1] as string).length,
    ordered,
    n: ordered ? Number.parseInt(marker, 10) : 1,
    text: m[3] ?? '',
  };
}

function blank(line: string): boolean {
  return line.trim() === '';
}

/** A line that starts a block of its own (so it ends a paragraph above it). */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || itemLine(line) !== null
  );
}

/** Whether line `i` starts a block that ends a paragraph above it. */
function interrupts(lines: string[], i: number): boolean {
  const line = lines[i] as string;
  return (
    blank(line) ||
    startsBlock(line) ||
    svgBlockAt(lines, i) !== null ||
    htmlBlockAt(lines, i) !== null ||
    tableAt(lines, i) !== null
  );
}

/** Parses message text into blocks. Empty text gives no blocks. */
export function parseMessage(text: string): Block[] {
  return parseBlocks(String(text).replace(/\r\n?/g, '\n').split('\n'));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const close = fence[1] as string;
      const closingFence = new RegExp(`^ {0,3}${close[0]}{${close.length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !closingFence.test(lines[i] as string)) {
        body.push(lines[i] as string);
        i++;
      }
      i++; // the closing fence (or the end of the message)
      blocks.push(codeBlock(fence[2] || null, body.join('\n')));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: (heading[1] as string).length as HeadingLevel,
        children: parseInline(heading[2] ?? ''),
      });
      i++;
      continue;
    }
    if (RULE.test(line) && !itemLine(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string)) {
        body.push((QUOTE.exec(lines[i] as string) as RegExpExecArray)[1] ?? '');
        i++;
      }
      blocks.push({ type: 'quote', children: parseBlocks(body) });
      continue;
    }
    if (itemLine(line)) {
      const [list, next] = parseList(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }
    const svg = svgBlockAt(lines, i);
    if (svg !== null) {
      blocks.push({ type: 'code', lang: 'svg', text: lines.slice(i, svg).join('\n').trim(), preview: 'svg' });
      i = svg;
      continue;
    }
    const html = htmlBlockAt(lines, i);
    if (html !== null) {
      blocks.push({
        type: 'code',
        lang: 'html',
        text: lines.slice(i, html).join('\n').trim(),
        preview: 'html',
      });
      i = html;
      continue;
    }
    const table = tableAt(lines, i);
    if (table !== null) {
      blocks.push(table[0]);
      i = table[1];
      continue;
    }
    const body: string[] = [line];
    i++;
    while (i < lines.length && !interrupts(lines, i)) {
      body.push(lines[i] as string);
      i++;
    }
    blocks.push({ type: 'paragraph', children: parseInline(body.map((l) => l.trim()).join('\n')) });
  }
  return blocks;
}

/** The largest `mermaid` block shown as a diagram, in characters (mermaid's own default `maxTextSize`). */
export const MERMAID_PREVIEW_MAX = 50_000;

/**
 * How a client may show a code block with this language and text besides its code (CT-149), or null:
 * - `svg`: the language is `svg` and the text is a standalone SVG document ({@link svgImageSrc} accepts it);
 * - `html`: the language is `html`, `htm` or `xhtml` and the text is a page or a fragment with a tag, not just an SVG
 *   document ({@link isHtmlPreviewable}); or no language and a page ({@link isHtmlDocument});
 * - `mermaid`: the language is `mermaid` and the text is not empty, at most {@link MERMAID_PREVIEW_MAX} characters.
 * Also for a client that shows a text attachment by its type.
 */
export function codePreview(lang: string | null, text: string): CodePreview | null {
  const l = lang?.toLowerCase() ?? null;
  if (l === 'svg') return isSvgDocument(text) ? 'svg' : null;
  if (l === 'html' || l === 'htm' || l === 'xhtml') return isHtmlPreviewable(text) ? 'html' : null;
  if (l === null) return isHtmlDocument(text) ? 'html' : null;
  if (l === 'mermaid') return text.trim() !== '' && text.length <= MERMAID_PREVIEW_MAX ? 'mermaid' : null;
  return null;
}

/**
 * A fenced block. Its language: `svg` for `xml`, `html` or no language around just an SVG document (CT-90), `html`
 * for no language around an HTML page, else as written.
 */
function codeBlock(written: string | null, text: string): CodeBlock {
  const l = written?.toLowerCase() ?? null;
  let lang = written;
  if (l === 'svg') lang = 'svg';
  else if ((l === null || l === 'xml' || l === 'html' || l === 'htm') && isSvgDocument(text)) lang = 'svg';
  else if (l === null && isHtmlDocument(text)) lang = 'html';
  const preview = codePreview(lang, text);
  return preview ? { type: 'code', lang, text, preview } : { type: 'code', lang, text };
}

const SVG_START = /^\s*(?:<\?xml\b|<svg[\s>/]|<svg$)/;

/**
 * An SVG document written as a paragraph of its own from line `start` (CT-90): lines from one starting with `<svg`
 * (or an `<?xml` prolog) to the line whose `</svg>` closes the root element, which must end that line. Returns the
 * index after the document's last line, or null when there is none (then the lines are ordinary text).
 */
function svgBlockAt(lines: string[], start: number): number | null {
  if (!SVG_START.test(lines[start] as string)) return null;
  let open = 0;
  let seen = false;
  let size = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] as string;
    size += line.length + 1;
    if (size > SVG_IMAGE_MAX) return null;
    // A self-closing <svg …/> opens nothing, so it is matched first.
    for (const m of line.matchAll(/<svg\b[^>]*\/>|<svg[\s>/]|<svg$|<\/svg\s*>/g)) {
      if (m[0].startsWith('</')) open--;
      else if (!m[0].endsWith('/>')) {
        open++;
        seen = true;
      }
    }
    if (seen && open <= 0) {
      return line.trimEnd().endsWith('</svg>') && isSvgDocument(lines.slice(start, i + 1).join('\n'))
        ? i + 1
        : null;
    }
  }
  return null;
}

const HTML_DOCTYPE_START = /^\s*(?:<!--.*?-->\s*)*<!doctype\s+html\b/i;
const HTML_TAG_START = /^\s*(?:<!--.*?-->\s*)*<html(?:[\s>]|$)/i;
const HTML_END = /<\/html\s*>\s*$/i;

/**
 * An HTML page written as a paragraph of its own from line `start` (CT-149): from a line starting with `<!DOCTYPE
 * html` or `<html` (after comments) to the first line ending in `</html>`, blank lines included. A page from
 * `<!DOCTYPE html` without `</html>` runs to the end of the message (browsers render it); one from `<html` without it
 * is text. Returns the index after its last line, or null. At most {@link HTML_PREVIEW_MAX} characters.
 */
function htmlBlockAt(lines: string[], start: number): number | null {
  const first = lines[start] as string;
  const doctype = HTML_DOCTYPE_START.test(first);
  if (!doctype && !HTML_TAG_START.test(first)) return null;
  let size = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] as string;
    size += line.length + 1;
    if (size > HTML_PREVIEW_MAX + 1) return null;
    if (HTML_END.test(line)) return i + 1;
  }
  return doctype ? lines.length : null;
}

/* Tables ---------------------------------------------------------------------------------------- */

const DELIM_CELL = /^:?-+:?$/;

/**
 * A table row's cells: the line split at `|` outside code spans and escapes, without the outer pipes. `\|` is a pipe
 * in the cell (in code spans too, as on GitHub). Null when the line has no unescaped pipe.
 */
function splitRow(line: string): string[] | null {
  const src = line.trim();
  const cells: string[] = [];
  let cell = '';
  let pipes = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '\\' && src[i + 1] === '|') {
      cell += '|';
      i += 2;
      continue;
    }
    if (c === '`') {
      const run = (/^`+/.exec(src.slice(i)) as RegExpExecArray)[0];
      const end = src.indexOf(run, i + run.length);
      if (end > 0) {
        cell += src.slice(i, end + run.length).replace(/\\\|/g, '|');
        i = end + run.length;
        continue;
      }
      cell += run;
      i += run.length;
      continue;
    }
    if (c === '|') {
      pipes++;
      cells.push(cell);
      cell = '';
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  cells.push(cell);
  if (pipes === 0) return null;
  if (src.startsWith('|')) cells.shift();
  if (src.endsWith('|') && !src.endsWith('\\|') && cells.length > 0) cells.pop();
  return cells.map((c) => c.trim());
}

function alignOf(cell: string): TableAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  return left && right ? 'center' : left ? 'left' : right ? 'right' : null;
}

/**
 * A GitHub table from line `start` (CT-149): a header row with a pipe, a delimiter row with as many cells (`---`,
 * `:--`, `:-:`, `--:`), then rows until a blank line, a line without a pipe or another block. Returns the table and
 * the index after it, or null.
 */
function tableAt(lines: string[], start: number): [TableBlock, number] | null {
  if (start + 1 >= lines.length) return null;
  const headLine = lines[start] as string;
  const delimLine = lines[start + 1] as string;
  if (!delimLine.includes('|') && !headLine.includes('|')) return null;
  const header = splitRow(headLine);
  const delim = splitRow(delimLine);
  if (!header || !delim || header.length === 0 || delim.length !== header.length) return null;
  if (!delim.every((c) => DELIM_CELL.test(c.replace(/\s+/g, '')))) return null;
  const width = header.length;
  const rows: Inline[][][] = [];
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (blank(line) || FENCE.test(line) || HEADING.test(line) || QUOTE.test(line)) break;
    const cells = splitRow(line);
    if (!cells) break;
    const row: Inline[][] = [];
    for (let c = 0; c < width; c++) row.push(parseInline(cells[c] ?? ''));
    rows.push(row);
    i++;
  }
  return [
    {
      type: 'table',
      align: delim.map((c) => alignOf(c.replace(/\s+/g, ''))),
      header: header.map((c) => parseInline(c)),
      rows,
    },
    i,
  ];
}

/* Lists ----------------------------------------------------------------------------------------- */

/**
 * A list from line `start`: items at the first item's indentation, deeper items (and lines indented under
 * an item) belong to that item. A blank line inside the list is allowed when the list goes on after it.
 */
function parseList(lines: string[], start: number): [ListBlock, number] {
  const first = itemLine(lines[start] as string) as ItemLine;
  const list: ListBlock = { type: 'list', ordered: first.ordered, start: first.n, items: [] };
  const checked: (boolean | null)[] = [];
  let i = start;
  while (i < lines.length) {
    const item = itemLine(lines[i] as string);
    if (!item || item.indent < first.indent || item.ordered !== first.ordered) break;
    if (item.indent > first.indent) break; // only reached through a malformed start; the caller goes on
    const task = TASK.exec(item.text);
    checked.push(task ? task[1] !== ' ' : null);
    const text: string[] = [task ? (task[2] ?? '') : item.text];
    const nested: string[] = [];
    i++;
    while (i < lines.length) {
      const line = lines[i] as string;
      if (blank(line)) {
        // Continue past a blank line only into more of this list.
        let afterIndex = i + 1;
        while (afterIndex < lines.length && blank(lines[afterIndex] as string)) afterIndex++;
        const after = lines[afterIndex];
        const next = after === undefined ? null : itemLine(after);
        const indented = after !== undefined && leadingSpaces(after) > first.indent;
        if ((next && next.indent >= first.indent) || indented) {
          i = afterIndex;
          continue;
        }
        break;
      }
      const sub = itemLine(line);
      if (sub && sub.indent <= first.indent) break;
      if (sub || nested.length > 0) nested.push(line);
      // Indented lines continue the item; an unindented one is the text after the list.
      else if (leadingSpaces(line) > first.indent) text.push(line.trim());
      else break;
      i++;
    }
    const blocks: Block[] = [{ type: 'paragraph', children: parseInline(text.join('\n')) }];
    if (nested.length) {
      const indent = Math.min(...nested.filter((l) => !blank(l)).map(leadingSpaces));
      blocks.push(...parseBlocks(nested.map((l) => l.slice(Math.min(indent, leadingSpaces(l))))));
    }
    list.items.push(blocks);
  }
  if (checked.some((c) => c !== null)) list.checked = checked;
  return [list, i];
}

function leadingSpaces(line: string): number {
  return (/^ */.exec(line) as RegExpExecArray)[0].length;
}

/* Inline ---------------------------------------------------------------------------------------- */

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i;
/** `@Name`. */
const MENTION = /^@[A-Z][a-z]+/u;
const WORD = /[\p{L}\p{N}]/u;

/** Parses one paragraph's text (newlines become breaks). */
export function parseInline(text: string): Inline[] {
  return inline(text, 0);
}

function inline(src: string, depth: number): Inline[] {
  const out: Inline[] = [];
  let labels: Map<number, number> | undefined;
  let buf = '';
  const flush = () => {
    if (buf) out.push(...textNodes(buf));
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const prev = i > 0 ? (src[i - 1] as string) : '';
    if (c === '\\' && i + 1 < src.length && /[\\`*_~[\]()#>+\-.!@]/.test(src[i + 1] as string)) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '\n') {
      flush();
      out.push({ type: 'break' });
      i++;
      continue;
    }
    if (c === '`') {
      const run = (/^`+/.exec(src.slice(i)) as RegExpExecArray)[0];
      const end = src.indexOf(run, i + run.length);
      if (end > i + run.length - 1 && !src.slice(i + run.length, end).includes('\n')) {
        const body = src.slice(i + run.length, end);
        flush();
        out.push({
          type: 'code',
          text: body.length > 2 && body.startsWith(' ') && body.endsWith(' ') ? body.slice(1, -1) : body,
        });
        i = end + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      labels ??= linkLabelEnds(src);
      const image = imageAt(src, i, labels.get(i + 1));
      if (image) {
        flush();
        out.push({ type: 'image', alt: image.alt, src: image.src });
        i = image.end;
        continue;
      }
    }
    if (c === '[' && depth < 3) {
      labels ??= linkLabelEnds(src);
      const link = linkAt(src, i, labels.get(i));
      if (link) {
        flush();
        out.push({ type: 'link', href: link.href, children: inline(link.label, depth + 1) });
        i = link.end;
        continue;
      }
    }
    if ((c === 'h' || c === 'H') && !WORD.test(prev)) {
      const m = BARE_URL.exec(src.slice(i));
      if (m) {
        const url = trimUrl(m[0]);
        flush();
        out.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
        i += url.length;
        continue;
      }
    }
    if (c === '@' && !WORD.test(prev)) {
      const m = MENTION.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ type: 'mention', text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if ((c === '*' || c === '_' || c === '~') && depth < 6) {
      const span = emphasisAt(src, i);
      if (span) {
        flush();
        out.push({ type: span.type, children: inline(span.body, depth + 1) } as Inline);
        i = span.end;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Match labels once, so unmatched or nested brackets never rescan the rest of the paragraph. */
function linkLabelEnds(src: string): Map<number, number> {
  const ends = new Map<number, number>();
  const opens: number[] = [];
  for (let j = 0; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\n') opens.length = 0;
    else if (ch === '[') opens.push(j);
    else if (ch === ']') {
      const open = opens.pop();
      if (open !== undefined && src[j + 1] === '(') ends.set(open, j);
    }
  }
  return ends;
}

/**
 * `[label](href)` at `i`, with a safe href; anything else is not a link. Parentheses in the href are balanced
 * (`…/wiki/Rust_(language)`), and the destination stays on one line.
 */
function linkAt(
  src: string,
  i: number,
  j: number | undefined,
): { label: string; href: string; end: number } | null {
  if (j === undefined) return null;
  const close = destinationEnd(src, j + 2);
  if (close === null) return null;
  const href =
    src
      .slice(j + 2, close)
      .trim()
      .split(/\s+/)[0] ?? '';
  const label = src.slice(i + 1, j);
  if (!label || !SAFE_HREF.test(href)) return null;
  return { label, href, end: close + 1 };
}

/**
 * `![alt](src)` at `i` (the `!`), with a safe image source: `(src)`, `(<src>)` or `(src "title")`, parentheses in the
 * source balanced. Anything else is not an image (and stays text, or a link after the `!`).
 */
function imageAt(
  src: string,
  i: number,
  j: number | undefined,
): { alt: string; src: string; end: number } | null {
  if (j === undefined) return null;
  const close = destinationEnd(src, j + 2);
  if (close === null) return null;
  const k = close + 1;
  const dest = src.slice(j + 2, close).trim();
  const angle = dest.startsWith('<') ? dest.indexOf('>') : -1;
  const url = angle > 0 ? dest.slice(1, angle) : (dest.split(/\s+/)[0] ?? '');
  if (!isSafeImageSrc(url)) return null;
  const alt = src
    .slice(i + 2, j)
    .replace(/\\([\\`*_~[\]()#>+\-.!@])/g, '$1')
    .trim();
  return { alt, src: url, end: k };
}

/**
 * The index of the `)` that closes a link or image destination starting at `from` (just after its `(`), with
 * parentheses inside balanced; null when the line ends first.
 */
function destinationEnd(src: string, from: number): number | null {
  let parens = 1;
  for (let k = from; k < src.length; k++) {
    const ch = src[k];
    if (ch === '\n') return null;
    if (ch === '(') parens++;
    else if (ch === ')' && --parens === 0) return k;
  }
  return null;
}

/** Trailing punctuation after a bare URL belongs to the sentence (and `)` unless the URL opened one). */
function trimUrl(url: string): string {
  let end = url.length;
  let extraClosing: number | undefined;
  while (end > 0) {
    const last = url[end - 1] as string;
    if (/[.,;:!?'"’”]/.test(last)) end--;
    else if (last === ')') {
      // Count once: removing a long run of sentence punctuation must not rescan the URL each time.
      if (extraClosing === undefined) {
        extraClosing = 0;
        for (let i = 0; i < end; i++) {
          if (url[i] === ')') extraClosing++;
          else if (url[i] === '(') extraClosing--;
        }
      }
      if (extraClosing <= 0) break;
      extraClosing--;
      end--;
    } else break;
  }
  return url.slice(0, end);
}

/**
 * `**bold**` / `__bold__`, `*em*` / `_em_`, `~~strike~~` at `i`. The opening delimiter must be followed by a
 * non-space and the closing one preceded by one; `_` only counts at word edges, so snake_case and
 * file_names_like_this stay text.
 */
function emphasisAt(
  src: string,
  i: number,
): { type: 'strong' | 'em' | 'strike'; body: string; end: number } | null {
  const c = src[i] as string;
  const double = src[i + 1] === c;
  if (c === '~' && !double) return null;
  const delim = double ? c + c : c;
  const type = c === '~' ? 'strike' : double ? 'strong' : 'em';
  const prev = i > 0 ? (src[i - 1] as string) : '';
  if (c === '_' && WORD.test(prev)) return null;
  const open = i + delim.length;
  if (open >= src.length || /\s/.test(src[open] as string)) return null;
  let j = open;
  while (j < src.length) {
    let k = src.indexOf(delim, j);
    if (k < 0) return null;
    // `***` closing `**`: the last two stars close it, the first one closes an inner `*em*`.
    if (double) while (src[k + 2] === c) k++;
    const body = src.slice(open, k);
    const after = src[k + delim.length] ?? '';
    const closes =
      k > open &&
      !/\s/.test(src[k - 1] as string) &&
      // A single `*` that is half of `**` does not close `*em*`.
      (double || (src[k - 1] !== c && src[k + 1] !== c)) &&
      !(c === '_' && WORD.test(after)) &&
      !body.includes('\n\n');
    if (closes && balancedCode(body)) return { type, body, end: k + delim.length };
    j = k + 1;
  }
  return null;
}

/** A delimiter inside a code span does not close emphasis. */
function balancedCode(body: string): boolean {
  return (body.match(/`/g)?.length ?? 0) % 2 === 0;
}

/** Plain text with curly quotes. */
function textNodes(text: string): Inline[] {
  return [{ type: 'text', text: smartQuotes(text) }];
}

/**
 * Straight quotes → typographic ones (the product’s copy rule): apostrophes and closing single quotes ’,
 * opening ‘ after a space or bracket, “ opening and ” closing double quotes.
 */
export function smartQuotes(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c !== "'" && c !== '"') {
      out += c;
      continue;
    }
    const prev = i > 0 ? (text[i - 1] as string) : '';
    const opening = prev === '' || /[\s([{“‘—–-]/.test(prev);
    if (c === '"') out += opening ? '“' : '”';
    else out += opening && !/\d/.test(text[i + 1] ?? '') ? '‘' : '’';
  }
  return out;
}

/* Plain text ------------------------------------------------------------------------------------ */

/** The words of an inline run, without formatting. */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
        case 'mention':
        case 'code':
          return n.text;
        case 'break':
          return '\n';
        case 'image':
          return n.alt || '[image]';
        default:
          return inlineText(n.children);
      }
    })
    .join('');
}

function blockText(block: Block, prefix = ''): string {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return inlineText(block.children);
    case 'code':
      if (block.preview === 'svg' || (block.lang === 'svg' && svgImageSrc(block.text) !== null))
        return '[image]';
      if (block.preview === 'html') {
        const title = htmlTitle(block.text);
        return title ? `[page: ${title}]` : '[page]';
      }
      if (block.preview === 'mermaid') return '[diagram]';
      return block.text;
    case 'rule':
      return '';
    case 'quote':
      return block.children.map((b) => blockText(b)).join('\n');
    case 'table':
      return [block.header, ...block.rows]
        .map((row) => row.map((cell) => inlineText(cell).replace(/\n/g, ' ')).join(' | '))
        .join('\n');
    case 'list':
      return block.items
        .map((item, n) => {
          const task = block.checked?.[n];
          const box = task === true ? '☑ ' : task === false ? '☐ ' : '';
          return item
            .map((b, k) =>
              k === 0
                ? `${prefix}${block.ordered ? `${block.start + n}.` : '•'} ${box}${blockText(b)}`
                : blockText(b, `${prefix}  `),
            )
            .join('\n');
        })
        .join('\n');
  }
}

/**
 * Message text without Markdown, for places that show plain text (notifications, push, previews):
 * “**Worth a look**\n- `CI` failed” → “Worth a look\n• CI failed”. An SVG is `[image]`, an HTML page `[page: its
 * title]` (or `[page]`), a Mermaid diagram `[diagram]`, a table its rows with cells between ` | `, a task item
 * `☐`/`☑` after its bullet.
 */
export function plainMessageText(text: string): string {
  return parseMessage(text)
    .map((b) => blockText(b))
    .filter((t) => t !== '')
    .join('\n');
}
