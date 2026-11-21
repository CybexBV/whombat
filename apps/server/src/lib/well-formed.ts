// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL can't be stored in Postgres text.
const NUL = /\u0000/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Every string of a parsed JSON value made storable: NUL removed and lone surrogates replaced, so neither Postgres
 * (`text` and `jsonb` refuse `\u0000`) nor canonical JSON can choke on it. Nesting past 8 levels becomes null.
 */
export function wellFormed(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === 'string') return value.replace(NUL, '').replace(LONE_SURROGATE, '�');
  if (Array.isArray(value)) return value.map((v) => wellFormed(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      out[wellFormed(k, depth + 1) as string] = wellFormed(v, depth + 1);
    return out;
  }
  return value;
}
