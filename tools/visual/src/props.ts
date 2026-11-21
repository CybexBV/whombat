/**
 * Pure helpers for the `data-props` attribute on `<script data-dc-script>` in the design references.
 * The attribute holds JSON metadata per prop: `{editor, options?, default, tsType}`; the runtime renders
 * with each prop's `default`, so rewriting defaults selects the screen/theme/avatar to render.
 */

export interface PropMeta {
  editor?: string;
  options?: string[];
  default?: unknown;
  tsType?: string;
}

export type PropsMeta = Record<string, PropMeta>;

const SCRIPT_TAG = /<script\b[^>]*\bdata-dc-script\b[^>]*>/;
const DATA_PROPS = /\bdata-props="([^"]*)"/;

const decodeAttr = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const encodeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Read the prop metadata of a reference file (empty object when it has none). */
export function readPropsMeta(html: string): PropsMeta {
  const tag = SCRIPT_TAG.exec(html)?.[0];
  const attr = tag ? DATA_PROPS.exec(tag)?.[1] : undefined;
  if (attr === undefined) return {};
  return JSON.parse(decodeAttr(attr)) as PropsMeta;
}

/** Visible prop names (keys starting with `$` are runtime metadata such as `$preview`). */
export function propNames(meta: PropsMeta): string[] {
  return Object.keys(meta).filter((k) => !k.startsWith('$'));
}

function coerce(name: string, meta: PropMeta, raw: string): unknown {
  if (meta.tsType === 'boolean' || meta.editor === 'boolean') {
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new Error(`Prop "${name}" is a boolean; got "${raw}"`);
  }
  if (meta.tsType === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`Prop "${name}" is a number; got "${raw}"`);
    return n;
  }
  if (meta.options && !meta.options.includes(raw)) {
    throw new Error(`Prop "${name}" must be one of ${meta.options.join(', ')}; got "${raw}"`);
  }
  return raw;
}

/** Return the HTML with the given props' defaults replaced. Throws on unknown props or invalid values. */
export function rewriteDataProps(html: string, overrides: Record<string, string>): string {
  const keys = Object.keys(overrides);
  if (keys.length === 0) return html;
  const tagMatch = SCRIPT_TAG.exec(html);
  const tag = tagMatch?.[0];
  if (!tagMatch || !tag || !DATA_PROPS.test(tag)) {
    throw new Error(`This reference has no data-props; cannot set ${keys.join(', ')}`);
  }
  const meta = readPropsMeta(html);
  for (const key of keys) {
    const m = meta[key];
    if (!m || key.startsWith('$')) {
      throw new Error(`Unknown prop "${key}". Known props: ${propNames(meta).join(', ')}`);
    }
    m.default = coerce(key, m, overrides[key] as string);
  }
  const newTag = tag.replace(DATA_PROPS, `data-props="${encodeAttr(JSON.stringify(meta))}"`);
  return html.slice(0, tagMatch.index) + newTag + html.slice(tagMatch.index + tag.length);
}
