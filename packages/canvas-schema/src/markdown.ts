/**
 * Canvas Markdown: the small dialect agents read and write (`canvas_read` / `canvas_edit`) and the seed is
 * authored in. CommonMark-like blocks and inline marks plus two extensions:
 *
 *   # Title                      the article title (first line of a document only; `#` elsewhere is an h2)
 *   ## Section / ### Sub         headings
 *   - item / 1. item             bullet and ordered lists (indent two spaces to nest)
 *   **bold** _italic_ (or *italic*) `code`
 *   ==text==                     highlight by the writer; `==text=={author=prn_dusty}` names the author
 *   :::plan{id=pln_invoice-pdf}  a plan block bound to a Plan; the steps come from the Plan, and the lines
 *   - [x] Pick a PDF library …   up to the closing `:::` are only a readable listing
 *   :::
 *
 * Parsing yields ProseMirror JSON for `canvasSchema`; `docToMarkdown` writes the same dialect back.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { MARKS, NODES } from './names.js';
import type { DocJSON } from './schema.js';

export interface PlanStepLike {
  id: string;
  title: string;
  state: string;
  stateLabel: string;
}

export interface PlanLike {
  id: string;
  steps: readonly PlanStepLike[];
}

export interface ParseOptions {
  /** Plans for `:::plan{id=…}` blocks. Unknown plans produce an empty plan block (or throw, see below). */
  plan?: (planId: string) => PlanLike | null | undefined;
  /** Throw on a plan block whose plan is unknown instead of rendering it empty. */
  strictPlans?: boolean;
  /** Author of `==text==` highlights that do not name one. */
  highlightAuthor?: string | null;
  /** Every highlight is by `highlightAuthor`, whatever the Markdown says (agents highlight as themselves). */
  forceHighlightAuthor?: boolean;
}

export interface DocumentParseOptions extends ParseOptions {
  /** Title used when the Markdown does not start with `# …`. */
  fallbackTitle?: string;
}

type MarkJSON = { type: string; attrs?: Record<string, unknown> };

export class CanvasMarkdownError extends Error {}

/* Blocks ----------------------------------------------------------------------------------------- */

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^( *)([-*+])\s+(.*)$/;
const ORDERED = /^( *)(\d{1,9})[.)]\s+(.*)$/;
const PLAN_OPEN = /^:::plan\s*\{([^}]*)\}\s*$/;
const FENCE_CLOSE = /^:::\s*$/;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function startsBlock(line: string): boolean {
  return HEADING.test(line) || BULLET.test(line) || ORDERED.test(line) || PLAN_OPEN.test(line);
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g)) {
    out[m[1] as string] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

export function planBlockJSON(plan: PlanLike): DocJSON {
  return {
    type: NODES.planBlock,
    attrs: { planId: plan.id },
    content: plan.steps.map((s) => ({
      type: NODES.planStep,
      attrs: { stepId: s.id, state: s.state, stateLabel: s.stateLabel },
      ...(s.title ? { content: [{ type: NODES.text, text: s.title }] } : {}),
    })),
  };
}

interface ListItemLines {
  first: string;
  rest: string[];
}

class BlockParser {
  constructor(private readonly opts: ParseOptions) {}

  parse(lines: string[]): DocJSON[] {
    const blocks: DocJSON[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i] as string;
      if (isBlank(line)) {
        i++;
        continue;
      }
      const plan = PLAN_OPEN.exec(line);
      if (plan) {
        let j = i + 1;
        while (j < lines.length && !FENCE_CLOSE.test(lines[j] as string)) j++;
        blocks.push(this.planBlock(parseAttrs(plan[1] as string).id ?? '', lines.slice(i + 1, j)));
        i = j + 1;
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        const level = Math.min(3, Math.max(2, (heading[1] as string).length));
        blocks.push({ type: NODES.heading, attrs: { level }, content: this.inline(heading[2] as string) });
        i++;
        continue;
      }
      if (BULLET.test(line) || ORDERED.test(line)) {
        const { block, next } = this.list(lines, i);
        blocks.push(block);
        i = next;
        continue;
      }
      const para: string[] = [];
      while (
        i < lines.length &&
        !isBlank(lines[i] as string) &&
        (para.length === 0 || !startsBlock(lines[i] as string))
      ) {
        para.push((lines[i] as string).trim());
        i++;
      }
      blocks.push({ type: NODES.paragraph, content: this.paragraphInline(para) });
    }
    return blocks;
  }

  private planBlock(planId: string, listing: string[]): DocJSON {
    const plan = planId ? this.opts.plan?.(planId) : null;
    if (plan) return planBlockJSON(plan);
    if (this.opts.strictPlans) throw new CanvasMarkdownError(`Unknown plan “${planId}”.`);
    const steps = listing
      .map((l) => /^\s*[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({
        type: NODES.planStep,
        attrs: {
          stepId: null,
          state: m[1] && m[1] !== ' ' ? 'done' : 'queued',
          stateLabel: m[1] && m[1] !== ' ' ? 'Done' : 'Queued',
        },
        content: [{ type: NODES.text, text: (m[2] as string).trim() }],
      }))
      .filter((s) => s.content[0]?.text);
    return { type: NODES.planBlock, attrs: { planId: planId || null }, content: steps };
  }

  /** A list starting at `lines[start]`: items at the first item's indentation; deeper lines nest. */
  private list(lines: string[], start: number): { block: DocJSON; next: number } {
    const first = lines[start] as string;
    const ordered = !BULLET.test(first);
    const markerRe = ordered ? ORDERED : BULLET;
    const head = markerRe.exec(first) as RegExpExecArray;
    const indent = (head[1] as string).length;
    const items: ListItemLines[] = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i] as string;
      const m = markerRe.exec(line);
      if (m && (m[1] as string).length === indent) {
        items.push({ first: m[3] as string, rest: [] });
        i++;
        continue;
      }
      const lineIndent = line.length - line.trimStart().length;
      if (items.length && !isBlank(line) && lineIndent > indent) {
        items[items.length - 1]?.rest.push(line.slice(Math.min(lineIndent, indent + 2)));
        i++;
        continue;
      }
      // A blank line inside a list continues it when the next line is another item or nested content.
      if (isBlank(line) && i + 1 < lines.length) {
        const nextLine = lines[i + 1] as string;
        const nm = markerRe.exec(nextLine);
        const nIndent = nextLine.length - nextLine.trimStart().length;
        if ((nm && (nm[1] as string).length === indent) || (!isBlank(nextLine) && nIndent > indent)) {
          i++;
          continue;
        }
      }
      break;
    }
    const content = items.map((item) => {
      const children: DocJSON[] = [{ type: NODES.paragraph, content: this.inline(item.first.trim()) }];
      if (item.rest.length) children.push(...this.parse(item.rest));
      return { type: NODES.listItem, content: children };
    });
    const startNumber = ordered ? Number(head[2]) : 1;
    return {
      block: ordered
        ? { type: NODES.orderedList, attrs: { start: startNumber, type: null }, content }
        : { type: NODES.bulletList, content },
      next: i,
    };
  }

  /** Paragraph lines: joined with spaces; a trailing backslash is a hard line break. */
  private paragraphInline(lines: string[]): DocJSON[] {
    const out: DocJSON[] = [];
    lines.forEach((line, idx) => {
      const hard = line.endsWith('\\') && !line.endsWith('\\\\');
      const text = hard ? line.slice(0, -1) : line;
      out.push(...this.inline(text));
      if (idx < lines.length - 1) {
        if (hard) out.push({ type: NODES.hardBreak });
        else out.push({ type: NODES.text, text: ' ' });
      }
    });
    return mergeText(out);
  }

  inline(text: string): DocJSON[] {
    return mergeText(parseInline(text, [], this.opts));
  }
}

/* Inline ----------------------------------------------------------------------------------------- */

const ESCAPABLE = /[\\`*_=#[\]{}()+\-.!:|>~]/;

function withMark(marks: MarkJSON[], mark: MarkJSON): MarkJSON[] {
  if (mark.type === MARKS.code) return [mark];
  if (marks.some((m) => m.type === MARKS.code)) return marks;
  return [...marks.filter((m) => m.type !== mark.type || mark.type === MARKS.commentAnchor), mark];
}

function textNode(text: string, marks: MarkJSON[]): DocJSON {
  return marks.length ? { type: NODES.text, text, marks } : { type: NODES.text, text };
}

function parseInline(text: string, marks: MarkJSON[], opts: ParseOptions): DocJSON[] {
  const out: DocJSON[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(textNode(buf, marks));
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '\\' && i + 1 < text.length && ESCAPABLE.test(text[i + 1] as string)) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push(textNode(text.slice(i + 1, end), withMark(marks, { type: MARKS.code })));
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith('**', i)) {
      const end = findClose(text, '**', i + 2);
      if (end > i + 2) {
        flush();
        out.push(...parseInline(text.slice(i + 2, end), withMark(marks, { type: MARKS.bold }), opts));
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith('==', i)) {
      const end = findClose(text, '==', i + 2);
      if (end > i + 2) {
        let after = end + 2;
        let author = opts.highlightAuthor ?? null;
        const attrs = /^\{([^}]*)\}/.exec(text.slice(after));
        if (attrs) {
          after += attrs[0].length;
          const named = parseAttrs(attrs[1] as string).author;
          if (named && !opts.forceHighlightAuthor) author = named;
        }
        flush();
        const mark = { type: MARKS.authorHighlight, attrs: { authorId: author } };
        out.push(...parseInline(text.slice(i + 2, end), withMark(marks, mark), opts));
        i = after;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && text[i + 1] !== ch && text[i + 1] !== ' ') {
      const end = findClose(text, ch, i + 1);
      if (end > i + 1 && text[end - 1] !== ' ') {
        flush();
        out.push(...parseInline(text.slice(i + 1, end), withMark(marks, { type: MARKS.italic }), opts));
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** Index of the closing delimiter at or after `from`, skipping escapes and code spans; -1 if none. */
function findClose(text: string, delim: string, from: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > 0) {
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith(delim, i)) {
      // A single `*` must not be half of a `**`.
      if (delim.length === 1 && text[i + 1] === delim) {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

function sameMarks(a: MarkJSON[] | undefined, b: MarkJSON[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function mergeText(nodes: DocJSON[]): DocJSON[] {
  const out: DocJSON[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === NODES.text && !n.text) continue;
    if (last && last.type === NODES.text && n.type === NODES.text && sameMarks(last.marks, n.marks)) {
      last.text = `${last.text ?? ''}${n.text ?? ''}`;
    } else out.push({ ...n });
  }
  return out;
}

/** Drops marks a node type does not allow (the title has none; plan steps only comment anchors). */
function stripMarks(nodes: DocJSON[], allowed: readonly string[]): DocJSON[] {
  return mergeText(
    nodes
      .filter((n) => n.type === NODES.text)
      .map((n) => {
        const marks = (n.marks ?? []).filter((m) => allowed.includes(m.type));
        return marks.length ? { ...n, marks } : { type: n.type, text: n.text ?? '' };
      }),
  );
}

/* Entry points ----------------------------------------------------------------------------------- */

function splitLines(md: string): string[] {
  return md.replace(/\r\n?/g, '\n').split('\n');
}

/** Markdown → block nodes (no title): what an agent's edit inserts. */
export function markdownToBlocks(md: string, opts: ParseOptions = {}): DocJSON[] {
  return new BlockParser(opts).parse(splitLines(md));
}

/** Inline Markdown → text nodes (for replacing words inside a paragraph). */
export function markdownToInline(md: string, opts: ParseOptions = {}): DocJSON[] {
  return new BlockParser(opts).inline(md.replace(/\s*\n\s*/g, ' '));
}

/** A whole canvas: `# Title` first (or `fallbackTitle`), then blocks. Always valid for `canvasSchema`. */
export function markdownToDoc(md: string, opts: DocumentParseOptions = {}): DocJSON {
  const lines = splitLines(md);
  let i = 0;
  while (i < lines.length && isBlank(lines[i] as string)) i++;
  let title = opts.fallbackTitle ?? '';
  const heading = i < lines.length ? /^#\s+(.*?)\s*#*\s*$/.exec(lines[i] as string) : null;
  const parser = new BlockParser(opts);
  if (heading) {
    title = heading[1] as string;
    i++;
  }
  const titleContent = stripMarks(parser.inline(title), []);
  const blocks = parser.parse(lines.slice(i));
  return {
    type: NODES.doc,
    content: [
      { type: NODES.title, ...(titleContent.length ? { content: titleContent } : {}) },
      ...(blocks.length ? blocks : [{ type: NODES.paragraph }]),
    ],
  };
}

/* Serialize -------------------------------------------------------------------------------------- */

function escapeText(text: string): string {
  return text.replace(/([\\`*_])/g, '\\$1').replace(/==/g, '\\=\\=');
}

function escapeLineStart(line: string): string {
  if (/^(#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|:::)/.test(line)) return `\\${line}`;
  return line;
}

function markOpen(mark: Mark): string {
  switch (mark.type.name) {
    case MARKS.bold:
      return '**';
    case MARKS.italic:
      return '_';
    case MARKS.code:
      return '`';
    case MARKS.authorHighlight:
      return '==';
    default:
      return '';
  }
}

function markClose(mark: Mark): string {
  if (mark.type.name === MARKS.authorHighlight) {
    const author = mark.attrs.authorId as string | null;
    return author ? `=={author=${author}}` : '==';
  }
  return markOpen(mark);
}

const SERIALIZED_MARKS: readonly string[] = [MARKS.bold, MARKS.italic, MARKS.code, MARKS.authorHighlight];

/** Inline content of a textblock as Markdown. */
export function inlineToMarkdown(block: PMNode): string {
  let out = '';
  let active: Mark[] = [];
  const closeTo = (keep: number) => {
    for (let k = active.length - 1; k >= keep; k--) out += markClose(active[k] as Mark);
    active = active.slice(0, keep);
  };
  block.forEach((child) => {
    if (child.type.name === NODES.hardBreak) {
      closeTo(0);
      out += '\\\n';
      return;
    }
    if (!child.isText) return;
    const marks = child.marks.filter((m) => SERIALIZED_MARKS.includes(m.type.name));
    let keep = 0;
    while (keep < active.length && keep < marks.length && (active[keep] as Mark).eq(marks[keep] as Mark))
      keep++;
    closeTo(keep);
    for (const m of marks.slice(keep)) {
      out += markOpen(m);
      active.push(m);
    }
    const isCode = marks.some((m) => m.type.name === MARKS.code);
    out += isCode ? (child.text ?? '') : escapeText(child.text ?? '');
  });
  closeTo(0);
  return out;
}

function indentLines(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');
}

function blockToMarkdown(node: PMNode): string {
  switch (node.type.name) {
    case NODES.title:
      return `# ${node.textContent}`;
    case NODES.paragraph:
      return escapeLineStart(inlineToMarkdown(node));
    case NODES.heading:
      return `${'#'.repeat(Math.min(3, Math.max(2, Number(node.attrs.level) || 2)))} ${inlineToMarkdown(node)}`;
    case NODES.bulletList:
    case NODES.orderedList: {
      const ordered = node.type.name === NODES.orderedList;
      const start = Number(node.attrs.start ?? 1) || 1;
      const items: string[] = [];
      node.forEach((item, _offset, index) => {
        const marker = ordered ? `${start + index}. ` : '- ';
        const parts: string[] = [];
        item.forEach((child) => {
          parts.push(child.type.name === NODES.paragraph ? inlineToMarkdown(child) : blockToMarkdown(child));
        });
        const [first = '', ...rest] = parts;
        const pad = ' '.repeat(marker.length);
        items.push(marker + first + rest.map((r) => `\n${indentLines(r, pad)}`).join(''));
      });
      return items.join('\n');
    }
    case NODES.planBlock: {
      const lines = [`:::plan{id=${node.attrs.planId ?? ''}}`];
      node.forEach((step) => {
        const box = step.attrs.state === 'done' ? '[x]' : '[ ]';
        const label = step.attrs.stateLabel as string | null;
        lines.push(`- ${box} ${step.textContent}${label ? ` · ${label}` : ''}`);
      });
      lines.push(':::');
      return lines.join('\n');
    }
    default:
      return node.textContent;
  }
}

/** A canvas document as canvas Markdown (`canvas_read`, the `markdown` export column). */
export function docToMarkdown(doc: PMNode): string {
  const parts: string[] = [];
  doc.forEach((block) => {
    parts.push(blockToMarkdown(block));
  });
  return `${parts.join('\n\n').trimEnd()}\n`;
}

/** Plain text for search: every textblock on its own line. */
export function docToPlainText(doc: PMNode): string {
  const lines: string[] = [];
  doc.descendants((node) => {
    if (node.isTextblock) {
      const text = node.textBetween(0, node.content.size, ' ', ' ').trim();
      if (text) lines.push(text);
      return false;
    }
    return true;
  });
  return lines.join('\n');
}
