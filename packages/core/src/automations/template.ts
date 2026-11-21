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

/** Fills placeholders with text from the scope, cut to `max` characters. */
export function renderTemplate(template: string, scope: Record<string, unknown>, max = 8000): string {
  const out = template.replace(PLACEHOLDER, (_m, path: string) => asText(lookup(scope, path)));
  return out.length <= max ? out : `${out.slice(0, max - 1)}…`;
}

/**
 * Fills placeholders so the whole fits `max` characters by shortening the longest values, never the template's own
 * words: an agent step's rules stay whole however long what a stranger wrote is (TA-56). Values are cut to a common
 * length, each marked with “…”; only when the template's own words alone don't fit is the end cut, as `renderTemplate`.
 */
export function renderTemplateWithin(template: string, scope: Record<string, unknown>, max: number): string {
  const parts: string[] = [];
  const values: string[] = [];
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    parts.push(template.slice(last, m.index));
    values.push(asText(lookup(scope, m[1] as string)));
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(template.slice(last));
  const fixed = parts.reduce((n, p) => n + p.length, 0);
  const total = (cap: number) =>
    fixed + values.reduce((n, v) => n + (v.length <= cap ? v.length : cap + 1), 0);
  const join = (cap: number) =>
    parts.reduce((out, part, i) => out + part + (i < values.length ? cut(values[i] as string, cap) : ''), '');
  const longest = values.reduce((n, v) => Math.max(n, v.length), 0);
  if (total(longest) <= max) return join(longest);
  if (total(0) > max) return renderTemplate(template, scope, max);
  // The largest common length the values may keep.
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
const CLOSING_FENCE = /\[\[\/[a-z][a-z0-9 _-]*\]\]$/i;

function cut(value: string, cap: number): string {
  if (value.length <= cap) return value;
  // Preserve the closing fence of an outsider-content block so truncation can never leave a block unclosed.
  const closing = value.startsWith('[[') ? CLOSING_FENCE.exec(value)?.[0] : undefined;
  if (closing) {
    const keep = cap - closing.length - 2;
    if (keep > 0) return `${value.slice(0, keep).trimEnd()}…\n${closing}`;
    return closing.length <= cap ? closing : '';
  }
  return `${value.slice(0, cap).trimEnd()}…`;
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
