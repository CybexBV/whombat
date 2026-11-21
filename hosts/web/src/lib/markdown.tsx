// A small, safe Markdown renderer for the assistant's answers: the text is
// parsed into blocks and inlines, then built as React elements (never as
// HTML, so nothing in the text can inject markup). Supported: paragraphs
// (single line breaks kept), headings (bold lines), bullet and numbered
// lists (nested), fenced code, quotes, rules, tables, inline code, bold,
// italics and links. Links open in a new tab and only for http(s) URLs;
// anything else stays text.

import { Fragment, type ReactNode } from 'react';

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'heading'; level: number; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

// ---------------------------------------------------------------- blocks

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string) => /^ */.exec(line)![0].length;
const blank = (line: string) => line.trim() === '';

/** A line that ends a paragraph: another block starts. */
function startsBlock(line: string): boolean {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line);
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function alignOf(cell: string): Align {
  const l = cell.startsWith(':');
  const r = cell.endsWith(':');
  return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
}

/** Item lines of a list starting at lines[start]; returns the list block and the next line index. */
function parseList(lines: string[], start: number): [Block, number] {
  const first = LIST_RE.exec(lines[start]!)!;
  const base = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: string[][] = [];
  let contentIndent = 0;
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = LIST_RE.exec(line);
    // A sibling item: about the same indentation and the same kind of marker.
    if (m && m[1]!.length <= base + 1 && m[1]!.length >= base - 1 && /\d/.test(m[2]!) === ordered) {
      contentIndent = m[1]!.length + m[2]!.length + 1;
      items.push([m[3] ?? '']);
      i++;
      continue;
    }
    const cur = items[items.length - 1]!;
    if (blank(line)) {
      // Blank lines stay inside the list when the item or the list goes on after them.
      let j = i + 1;
      while (j < lines.length && blank(lines[j]!)) j++;
      const next = lines[j];
      if (next === undefined) break;
      const nm = LIST_RE.exec(next);
      const sibling = nm && nm[1]!.length <= base + 1 && /\d/.test(nm[2]!) === ordered;
      if (indentOf(next) >= contentIndent || sibling) {
        for (let k = i; k < j; k++) cur.push('');
        i = j;
        continue;
      }
      break;
    }
    const ind = indentOf(line);
    if (ind >= contentIndent || (ind > base && m)) {
      cur.push(line.slice(Math.min(ind, contentIndent)));
      i++;
      continue;
    }
    // A lazy continuation of the item's text, unless another block starts.
    if (!startsBlock(line) && cur.length && !blank(cur[cur.length - 1]!)) {
      cur.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  const n = Number.parseInt(first[2]!, 10);
  return [{ t: 'list', ordered, start: ordered && Number.isFinite(n) ? n : 1, items: items.map((l) => parseLines(l)) }, i];
}

function parseLines(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l);
        if (close && close[1]![0] === mark[0] && close[1]!.length >= mark.length) {
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      out.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      out.push({ t: 'heading', level: h[1]!.length, c: parseInline(h[2] ?? '') });
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i]!);
        if (q) body.push(q[1]!);
        else if (!blank(lines[i]!) && !startsBlock(lines[i]!) && body.length) body.push(lines[i]!);
        else break;
        i++;
      }
      out.push({ t: 'quote', c: parseLines(body) });
      continue;
    }
    if (LIST_RE.test(line)) {
      const [list, next] = parseList(lines, i);
      out.push(list);
      i = next;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM_RE.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map(alignOf);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]!) && lines[i]!.includes('|')) {
        const cells = splitRow(lines[i]!);
        rows.push(head.map((_, k) => parseInline(cells[k] ?? '')));
        i++;
      }
      out.push({ t: 'table', align: head.map((_, k) => align[k] ?? null), head: head.map((c) => parseInline(c)), rows });
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i]!) && !startsBlock(lines[i]!)) {
      para.push(lines[i]!.trim());
      i++;
    }
    out.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return out;
}

/** Markdown text -> blocks. */
export function parseMarkdown(text: string): Block[] {
  return parseLines(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}

// ---------------------------------------------------------------- inlines

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const WORD = /[\p{L}\p{N}]/u;

/** Only http(s) URLs become links. */
export function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Index of the `]` closing the `[` at `open`, or -1. */
function closingBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > 0) i = end;
    } else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return i;
  }
  return -1;
}

/** A bare URL's end: trailing punctuation and unbalanced ")" are not part of it. */
function bareUrlEnd(s: string, from: number): number {
  let end = from;
  while (end < s.length && !/[\s<>"`]/.test(s[end]!)) end++;
  while (end > from) {
    const c = s[end - 1]!;
    if (/[.,;:!?'*_]/.test(c)) end--;
    else if (c === ')') {
      const part = s.slice(from, end);
      if ((part.match(/\(/g)?.length ?? 0) < (part.match(/\)/g)?.length ?? 0)) end--;
      else break;
    } else break;
  }
  return end;
}

/** Closing delimiter `d` for an emphasis that opened before `from`: not after a space, and for `_` not inside a word. */
function closingDelim(s: string, from: number, d: string): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '`') {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) i = end + run.length - 1;
      continue;
    }
    if (s.startsWith(d, i) && i > from && !/\s/.test(s[i - 1]!)) {
      // "**" is not a closing "*".
      if (d.length === 1 && (s[i + 1] === d || s[i - 1] === d)) continue;
      if (d[0] === '_' && WORD.test(s[i + d.length] ?? '')) continue;
      return i;
    }
  }
  return -1;
}

/** Inline Markdown -> nodes; inside a link's text (`links` false) no further links are made. */
export function parseInline(s: string, links = true): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1]!)) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '\n') {
      flush();
      out.push({ t: 'br' });
      i++;
      continue;
    }
    if (c === '`') {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0 && s[end + run.length] !== '`') {
        let v = s.slice(i + run.length, end).replace(/\n/g, ' ');
        if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ')) v = v.slice(1, -1);
        flush();
        out.push({ t: 'code', v });
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    if (c === '[' && links) {
      const close = closingBracket(s, i);
      if (close > 0 && s[close + 1] === '(') {
        const m = /^\(\s*<?([^\s<>()]*(?:\([^\s()]*\)[^\s<>()]*)*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/.exec(s.slice(close + 1));
        if (m) {
          const href = safeHref(m[1]!);
          const label = parseInline(s.slice(i + 1, close), false);
          flush();
          if (href) out.push({ t: 'link', href, c: label });
          else out.push(...label);
          i = close + 1 + m[0].length;
          continue;
        }
      }
    }
    if (c === '<' && links) {
      const m = /^<(https?:\/\/[^\s<>]+)>/.exec(s.slice(i));
      const href = m ? safeHref(m[1]!) : null;
      if (m && href) {
        flush();
        out.push({ t: 'link', href, c: [{ t: 'text', v: m[1]! }] });
        i += m[0].length;
        continue;
      }
    }
    if (links && (c === 'h' || c === 'H') && /^https?:\/\//i.test(s.slice(i, i + 8)) && !WORD.test(s[i - 1] ?? '')) {
      const end = bareUrlEnd(s, i);
      const raw = s.slice(i, end);
      const href = safeHref(raw);
      if (href && raw.length > 8) {
        flush();
        out.push({ t: 'link', href, c: [{ t: 'text', v: raw }] });
        i = end;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      const double = s[i + 1] === c;
      const d = double ? c + c : c;
      const after = s[i + d.length] ?? '';
      const openOk = after !== '' && !/\s/.test(after) && after !== c && !(c === '_' && WORD.test(s[i - 1] ?? ''));
      if (openOk) {
        const end = closingDelim(s, i + d.length, d);
        if (end > 0) {
          flush();
          const inner = parseInline(s.slice(i + d.length, end), links);
          out.push(double ? { t: 'strong', c: inner } : { t: 'em', c: inner });
          i = end + d.length;
          continue;
        }
      }
      // A run without a partner stays text.
      const run = /^[*_]+/.exec(s.slice(i))![0];
      text += run;
      i += run.length;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- React

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, k) => {
    switch (n.t) {
      case 'text':
        return <Fragment key={k}>{n.v}</Fragment>;
      case 'br':
        return <br key={k} />;
      case 'code':
        return (
          <code key={k} className="md-code">
            {n.v}
          </code>
        );
      case 'strong':
        return <strong key={k}>{renderInline(n.c)}</strong>;
      case 'em':
        return <em key={k}>{renderInline(n.c)}</em>;
      case 'link':
        return (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer">
            {renderInline(n.c)}
          </a>
        );
    }
  });
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((b, k) => {
    switch (b.t) {
      case 'p':
        return <p key={k}>{renderInline(b.c)}</p>;
      case 'heading':
        return (
          <p key={k} className="md-h">
            <strong>{renderInline(b.c)}</strong>
          </p>
        );
      case 'code':
        return (
          // Focusable: a long line scrolls sideways (keyboard users scroll it too).
          <pre key={k} className="md-pre" tabIndex={0}>
            <code>{b.v}</code>
          </pre>
        );
      case 'list': {
        const items = b.items.map((it, j) => <li key={j}>{renderBlocks(it)}</li>);
        return b.ordered ? (
          <ol key={k} start={b.start !== 1 ? b.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        );
      }
      case 'quote':
        return <blockquote key={k}>{renderBlocks(b.c)}</blockquote>;
      case 'table':
        return (
          <div key={k} className="md-table" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>
                      {renderInline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((c, n) => (
                      <td key={n} style={b.align[n] ? { textAlign: b.align[n]! } : undefined}>
                        {renderInline(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'hr':
        return <hr key={k} />;
    }
  });
}

/** Markdown as React elements, in a `.md` container. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={className ? `md ${className}` : 'md'}>{renderBlocks(parseMarkdown(text))}</div>;
}
