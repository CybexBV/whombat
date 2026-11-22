/**
 * Step text templates: `{{trigger.text}}`, `{{steps.investigate.text}}` (everything an agent step's agent posted in its
 * turn), `{{steps.investigate.reply}}` (only its last message, 0.66). Values are filled in as plain text — never
 * re-read as a template, a condition or an instruction to the engine (BP-07: retrieved data is data).
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;

function lookup(scope: Record<string, unknown>, path: string): unknown {
  let cur: unknown = scope;
  for (const p of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, p)) return '';
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur ?? '';
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return '';
  return JSON.stringify(v);
}

function parseTemplate(
  template: string,
  scope: Record<string, unknown>,
): { parts: string[]; values: string[] } {
  const parts: string[] = [];
  const values: string[] = [];
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    parts.push(template.slice(last, m.index));
    values.push(asText(lookup(scope, m[1] as string)));
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(template.slice(last));
  return { parts, values };
}

function truncateStatic(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return max === 1 ? '…' : `${text.slice(0, max - 1)}…`;
}

/** Fills placeholders with text from the scope, cut to `max` characters without ever cutting inside a fenced block. */
export function renderTemplate(template: string, scope: Record<string, unknown>, max = 8000): string {
  const { parts, values } = parseTemplate(template, scope);
  const full = parts.reduce(
    (out, part, i) => out + part + (i < values.length ? (values[i] as string) : ''),
    '',
  );
  if (full.length <= max) return full;
  if (max <= 0) return '';
  if (max === 1) return '…';
  const limit = max - 1;
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    if (out.length + part.length > limit) return `${out}${part.slice(0, limit - out.length)}…`;
    out += part;
    if (i >= values.length) break;
    const val = values[i] as string;
    if (out.length + val.length <= limit) {
      out += val;
      continue;
    }
    const rem = limit - out.length;
    if (fenceParts(val)) return `${out}${cut(val, rem)}…`;
    return `${out}${val.slice(0, rem)}…`;
  }
  return `${out.slice(0, limit)}…`;
}

/**
 * Fills placeholders so the whole fits `max` characters by shortening the longest values, never the template's own
 * words: an agent step's rules stay whole however long what a stranger wrote is (TA-56). Values are cut to a common
 * length, each marked with “…”; fenced outsider blocks keep both opening and closing delimiters intact (or are dropped
 * when their delimiters can't fit). Only when the template's own words alone don't fit is the end cut, with values
 * dropped so no fenced block can ever be left open.
 */
export function renderTemplateWithin(template: string, scope: Record<string, unknown>, max: number): string {
  const { parts, values } = parseTemplate(template, scope);
  const fixed = parts.reduce((n, p) => n + p.length, 0);
  if (fixed > max) return truncateStatic(parts.join(''), max);
  const total = (cap: number) => fixed + values.reduce((n, v) => n + cut(v, cap).length, 0);
  const join = (cap: number) =>
    parts.reduce((out, part, i) => out + part + (i < values.length ? cut(values[i] as string, cap) : ''), '');
  const longest = values.reduce((n, v) => Math.max(n, v.length), 0);
  if (total(longest) <= max) return join(longest);
  // The largest common length the values may keep (`cut(v, cap).length` is monotonically non-decreasing in `cap`).
  let lo = 0;
  let hi = longest;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (total(mid) <= max) lo = mid;
    else hi = mid - 1;
  }
  return join(lo);
}

/** Matches a closing Whombat fence (`[[/mail]]`, `[[/report]]`, …) at the end of a fenced block. */
const CLOSING_FENCE = /\[\[\/([a-z][a-z0-9 _-]*)\]\]$/i;

interface FenceParts {
  opening: string;
  closing: string;
  sep: string;
  inner: string;
}

function fenceParts(value: string): FenceParts | null {
  if (!value.startsWith('[[')) return null;
  const closeMatch = CLOSING_FENCE.exec(value);
  if (!closeMatch) return null;
  const closing = closeMatch[0];
  const openEnd = value.indexOf(']]');
  if (openEnd < 2) return null;
  const headerEnd = openEnd + 2;
  if (headerEnd + closing.length > value.length) return null;
  const opening = value.slice(0, headerEnd);
  const tag = (closeMatch[1] as string).toLowerCase();
  if (!opening.slice(2, -2).toLowerCase().startsWith(tag)) return null;
  const rawInner = value.slice(headerEnd, value.length - closing.length);
  const sep = rawInner.includes('\n') ? '\n' : ' ';
  return { opening, closing, sep, inner: rawInner.trim() };
}

function cut(value: string, cap: number): string {
  if (cap <= 0) return '';
  if (value.length <= cap) return value;
  // Preserve both delimiters of a fenced outsider block so truncation never cuts inside them or leaves a block open.
  const fence = fenceParts(value);
  if (fence) {
    const empty = `${fence.opening}${fence.sep}${fence.closing}`;
    if (cap < empty.length) return '';
    const overhead = fence.opening.length + fence.sep.length * 2 + 1 + fence.closing.length;
    if (cap <= overhead || !fence.inner) return empty;
    const kept = fence.inner.slice(0, cap - overhead).trimEnd();
    return kept ? `${fence.opening}${fence.sep}${kept}…${fence.sep}${fence.closing}` : empty;
  }
  if (cap === 1) return '…';
  return `${value.slice(0, cap - 1).trimEnd()}…`;
}

/** Fills placeholders as JSON string contents (for a JSON body template: `{"text": "{{steps.a.text}}"}`). */
export function renderJsonTemplate(template: string, scope: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (_m, path: string) =>
    JSON.stringify(asText(lookup(scope, path))).slice(1, -1),
  );
}

/** Paths a template reads. */
export function templatePaths(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}
