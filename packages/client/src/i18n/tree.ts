/**
 * Word tables written as nested trees, English beside Dutch: a screen's words read as they do in its module, and the
 * catalog gets them as flat keys (`backupLook.entry`, `backupOptions.list.today`) for `scripts/i18n/` to check. A leaf
 * is a string, or a plural map (`{ one, other }`); anything else is a group.
 */
import {
  createTranslator,
  type MessageCatalog,
  type MessageValue,
  type MessageVars,
  type PluralCategory,
  type PluralMessage,
} from '@whombat/core/i18n';

const PLURAL_KEYS: ReadonlySet<string> = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

/** A tree of words: strings and plural maps, grouped. */
export type WordTreeSource = { readonly [key: string]: string | PluralMessage | WordTreeSource };

/** Whether a node is a plural leaf (only CLDR categories, `other` among them), not a group of words. */
export function isPluralLeaf(node: unknown): node is PluralMessage {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const keys = Object.keys(node);
  return keys.includes('other') && keys.every((k) => PLURAL_KEYS.has(k));
}

/** Whether a node's type is a plural leaf: only CLDR categories as keys (`leftOutWhy: { …, other }` is a group). */
type IsPlural<N> = N extends PluralMessage
  ? Exclude<keyof N, PluralCategory> extends never
    ? true
    : false
  : false;

/** The translation of a tree: the same groups and leaves, each leaf any message. */
export type TranslatedTree<T> = {
  readonly [K in keyof T]: T[K] extends string
    ? MessageValue
    : IsPlural<T[K]> extends true
      ? MessageValue
      : TranslatedTree<T[K]>;
};

/** A plural leaf as a module reads it: the count, and any other values. */
export type PluralWords = (count: number, vars?: MessageVars) => string;

/** A tree read in a locale: each string leaf a string (its `{holes}` kept), each plural leaf a function of the count. */
export type ReadTree<T> = {
  readonly [K in keyof T]: T[K] extends string
    ? string
    : IsPlural<T[K]> extends true
      ? PluralWords
      : ReadTree<T[K]>;
};

/** Flattens a tree into catalog entries under `prefix` (`prefix.group.leaf`). */
export function flattenTree(
  prefix: string,
  tree: object,
  out: Record<string, MessageValue> = {},
): MessageCatalog {
  for (const [key, node] of Object.entries(tree)) {
    const path = `${prefix}.${key}`;
    if (typeof node === 'string' || isPluralLeaf(node)) out[path] = node as MessageValue;
    else if (node && typeof node === 'object') flattenTree(path, node, out);
  }
  return out;
}

/** English and Dutch trees as the flat catalogs the client's catalog spreads in. */
export function treeCatalogs<const T extends WordTreeSource>(
  prefix: string,
  en: T,
  nl: TranslatedTree<T>,
): { en: MessageCatalog; nl: MessageCatalog; tree: T; prefix: string } {
  return { en: flattenTree(prefix, en), nl: flattenTree(prefix, nl), tree: en, prefix };
}

/**
 * Reads a tree in a locale: the shape of the English tree, every leaf through the catalogs (English for a key a
 * locale lacks, the pseudo-locale for QA).
 */
export function readTree<T extends WordTreeSource>(
  catalogs: { en: MessageCatalog; nl: MessageCatalog },
  prefix: string,
  shape: T,
  locale?: string | null,
): ReadTree<T> {
  const tr = createTranslator(catalogs, typeof locale === 'string' ? locale : undefined);
  const read = (node: WordTreeSource, path: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      const at = `${path}.${key}`;
      if (typeof value === 'string') out[key] = tr.t(at);
      else if (isPluralLeaf(value)) out[key] = (count: number, vars?: MessageVars) => tr.tp(at, count, vars);
      else out[key] = read(value, at);
    }
    return out;
  };
  return read(shape, prefix) as ReadTree<T>;
}
