/**
 * Small, pure string tools for the faces' SVG markup: find an element by its id, cut it out, put another in its place,
 * give every id a prefix. The drawings are generator output with a fixed shape (no comments, no CDATA, double-quoted
 * attributes), so a tag scan is enough and no XML parser is needed: the same code runs in the browser, on the phone and
 * in Node.
 */

/** Where an element starts and ends in the markup (`end` is just past its closing tag). */
export interface ElementSpan {
  start: number;
  end: number;
  tag: string;
}

/** The element whose `id` is `id` (or whose attribute `attr` is `value`), with its children. */
export function findElement(markup: string, id: string, attr = 'id'): ElementSpan | null {
  const open = new RegExp(`<([a-zA-Z]+)\\b[^>]*\\s${attr}="${escapeRegExp(id)}"[^>]*?(/?)>`).exec(markup);
  if (!open) return null;
  const tag = open[1] as string;
  const start = open.index;
  if (open[2] === '/') return { start, end: start + open[0].length, tag };
  // Count only this tag's own opening and closing tags: other tags can't close it.
  const scan = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'g');
  scan.lastIndex = start;
  let depth = 0;
  for (let m = scan.exec(markup); m; m = scan.exec(markup)) {
    if (m[2] === '/') continue;
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return { start, end: m.index + m[0].length, tag };
  }
  return null;
}

/** The element's markup, or null. */
export function elementMarkup(markup: string, id: string): string | null {
  const span = findElement(markup, id);
  return span ? markup.slice(span.start, span.end) : null;
}

/** The markup without the element (unchanged when it isn't there). */
export function removeElement(markup: string, id: string): string {
  const span = findElement(markup, id);
  return span ? markup.slice(0, span.start) + markup.slice(span.end) : markup;
}

/** The markup with the element replaced by `replacement` (unchanged when it isn't there). */
export function replaceElement(markup: string, id: string, replacement: string): string {
  const span = findElement(markup, id);
  return span ? markup.slice(0, span.start) + replacement + markup.slice(span.end) : markup;
}

/** `insert` just after the element's closing tag (unchanged when it isn't there). */
export function insertAfter(markup: string, id: string, insert: string): string {
  const span = findElement(markup, id);
  return span ? markup.slice(0, span.end) + insert + markup.slice(span.end) : markup;
}

/** `insert` just before the element's closing tag, as its last child (unchanged when it isn't there). */
export function appendInside(markup: string, id: string, insert: string): string {
  const span = findElement(markup, id);
  if (!span) return markup;
  const close = `</${span.tag}>`;
  const at = span.end - close.length;
  return markup.slice(0, at) + insert + markup.slice(at);
}

/** The value of attribute `name` on the element with id `id`, or null. */
export function attributeOf(markup: string, id: string, name: string): string | null {
  const span = findElement(markup, id);
  if (!span) return null;
  const head = markup.slice(span.start, markup.indexOf('>', span.start) + 1);
  return new RegExp(`\\s${name}="([^"]*)"`).exec(head)?.[1] ?? null;
}

/** The element's opening tag with attribute `name` set to `value` (added when missing). */
export function setAttribute(markup: string, id: string, name: string, value: string): string {
  const span = findElement(markup, id);
  if (!span) return markup;
  const close = markup.indexOf('>', span.start);
  const head = markup.slice(span.start, close);
  const re = new RegExp(`(\\s${name}=")[^"]*(")`);
  const next = re.test(head) ? head.replace(re, `$1${value}$2`) : `${head} ${name}="${value}"`;
  return markup.slice(0, span.start) + next + markup.slice(close);
}

/** Wraps the element in `<g …attrs>`…`</g>` (unchanged when it isn't there). */
export function wrapElement(markup: string, id: string, attrs: string): string {
  const span = findElement(markup, id);
  if (!span) return markup;
  return `${markup.slice(0, span.start)}<g ${attrs}>${markup.slice(span.start, span.end)}</g>${markup.slice(span.end)}`;
}

/**
 * Every `id`, `url(#…)` and `href="#…"` with `prefix` in front, so many drawings share one page: the files all use the
 * same ids (`fur`, `eye`, `mc`…).
 */
export function prefixIds(markup: string, prefix: string): string {
  return markup
    .replace(/\sid="([^"]+)"/g, ` id="${prefix}$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
    .replace(/href="#([^"]+)"/g, `href="#${prefix}$1"`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
