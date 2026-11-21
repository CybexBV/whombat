/**
 * Structural bounds on a public submission body (docs/decisions/feedback.md FB-F01, review 1 R1-1). The schema
 * alone is no bound: Zod validates every element of an array before it applies `.max()`, and records an issue per
 * bad element, so one body with millions of elements could block the event loop for seconds and allocate
 * gigabytes. Two cheap passes run before it, and either refuses the body with a 400 `invalid`:
 *
 * 1. `scanJsonShape` over the raw bytes, before `JSON.parse`: nesting depth and the number of structural tokens
 *    (`[`, `{`, `,`) outside strings. Strings are skipped with a native `indexOf`, so a body of screenshots costs
 *    next to nothing, and a body of millions of tiny values stops at the first token over the limit.
 * 2. `checkStructure` over the parsed value: exact limits per level (array lengths per known field, keys per
 *    object, string lengths per known field, total nodes).
 *
 * The limits are far above anything the widget sends (a submission is at most four levels deep and has well under
 * a hundred values) and far below what costs anything to validate.
 */
import {
  FEEDBACK_CONTEXT_LIMITS,
  FEEDBACK_MAX_ATTACHMENT_BYTES,
  FEEDBACK_MAX_ATTACHMENTS,
} from '@whombat/core';

export const SUBMISSION_BOUNDS = {
  /** Nesting levels (the widget's deepest value, `context.browser.viewport.width`, is at level 4). */
  depth: 6,
  /** Values in the whole body (every string, number, boolean, null, array and object counts). */
  nodes: 2000,
  /** Keys of any one object. */
  keys: 40,
  /** Elements of an array that isn't one of the known fields below. */
  array: 20,
  /** Characters of any string (or key) other than a screenshot's base64 data. */
  string: 10_000,
  /** Characters of `attachments.<i>.data` (the schema's own maximum). */
  attachmentData: Math.ceil(FEEDBACK_MAX_ATTACHMENT_BYTES / 3) * 4 + 4,
} as const;

/** Arrays of the submission and their own caps (the schema's maxima). */
const ARRAY_CAPS = new Map<string, number>([
  ['attachments', FEEDBACK_MAX_ATTACHMENTS],
  ['context.references', FEEDBACK_CONTEXT_LIMITS.references],
  // The visitor's last page views (FR-04).
  ['context.trail', FEEDBACK_CONTEXT_LIMITS.trail],
]);

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const COMMA = 0x2c;

/**
 * True when the raw JSON text nests at most `depth` levels and has at most `nodes` structural tokens outside
 * strings. Works on UTF-8 bytes: every byte of a multi-byte character is ≥ 0x80, so it is never taken for one of
 * JSON's ASCII delimiters. Malformed JSON may pass (`JSON.parse` refuses it next); an unterminated string fails.
 */
export function scanJsonShape(
  body: Buffer,
  bounds: { depth: number; nodes: number } = SUBMISSION_BOUNDS,
): boolean {
  let depth = 0;
  let tokens = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === QUOTE) {
      // Jump to the closing quote: the next `"` not escaped by an odd run of backslashes.
      let from = i + 1;
      for (;;) {
        const q = body.indexOf(QUOTE, from);
        if (q < 0) return false;
        let slashes = 0;
        for (let k = q - 1; k > i && body[k] === BACKSLASH; k--) slashes++;
        if (slashes % 2 === 0) {
          i = q;
          break;
        }
        from = q + 1;
      }
    } else if (c === OPEN_ARRAY || c === OPEN_OBJECT) {
      if (++depth > bounds.depth || ++tokens > bounds.nodes) return false;
    } else if (c === CLOSE_ARRAY || c === CLOSE_OBJECT) {
      depth--;
    } else if (c === COMMA) {
      if (++tokens > bounds.nodes) return false;
    }
  }
  return true;
}

/**
 * Null when the parsed body is within `SUBMISSION_BOUNDS`, else the field to name in the 400. Only the paths of
 * known fields are tracked (anything under an unknown or long key is `*`), so the walk allocates next to nothing.
 */
export function checkStructure(value: unknown, bounds = SUBMISSION_BOUNDS): string | null {
  let nodes = 0;
  const walk = (v: unknown, path: string, depth: number): string | null => {
    if (++nodes > bounds.nodes) return 'body';
    if (typeof v === 'string') {
      const cap = /^attachments\.#\.data$/.test(path) ? bounds.attachmentData : bounds.string;
      return v.length > cap ? 'body' : null;
    }
    if (v === null || typeof v !== 'object') return null;
    // Containers count as levels (like `scanJsonShape`): the root object is level 1.
    if (depth > bounds.depth) return 'body';
    if (Array.isArray(v)) {
      const known = ARRAY_CAPS.get(path);
      if (v.length > (known ?? bounds.array)) return known === undefined ? 'body' : path;
      const child = path === '*' ? '*' : `${path}.#`;
      for (const el of v) {
        const bad = walk(el, child, depth + 1);
        if (bad) return bad;
      }
      return null;
    }
    const keys = Object.keys(v);
    if (keys.length > bounds.keys) return 'body';
    for (const key of keys) {
      if (key.length > bounds.string) return 'body';
      const child = path === '*' || !/^[A-Za-z]{1,32}$/.test(key) ? '*' : path ? `${path}.${key}` : key;
      const bad = walk((v as Record<string, unknown>)[key], child, depth + 1);
      if (bad) return bad;
    }
    return null;
  };
  return walk(value, '', 1);
}
