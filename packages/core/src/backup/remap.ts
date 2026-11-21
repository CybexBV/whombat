/**
 * Moving a record's references from the box that made the file to the box restoring it (CT-335, BF-04): a restore keeps
 * a map from source ids to target ids (its restore map) and rewrites JSON it stores as is — an automation's definition
 * and draft, a feedback integration's settings, a card — with `remapBackupIds`.
 */
import type { JsonValue } from '../domain/common.js';
import { ID_PREFIXES } from '../ids.js';

const ID_PATTERN = new RegExp(`^(?:${Object.values(ID_PREFIXES).join('|')})_[A-Za-z0-9_-]{1,64}$`);

/** Whether a string is a whole Whombat id (`prn_banjo`, `cnv_general`, `con_x1`). */
export function isWhombatId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** Every whole-id string value in a JSON value (object keys aren't ids). */
export function collectBackupIds(value: JsonValue, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    if (isWhombatId(value)) into.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectBackupIds(v, into);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectBackupIds(v, into);
  }
  return into;
}

/**
 * A copy of `value` with every whole-id string the lookup knows replaced by its target id. Ids the lookup doesn't know
 * stay as they are and are listed in `missing` (the restore drops or notes them). Ids inside longer strings (a template,
 * a URL) are not touched.
 */
export function remapBackupIds<T extends JsonValue>(
  value: T,
  lookup: ReadonlyMap<string, string> | ((sourceId: string) => string | undefined),
): { value: T; missing: string[] } {
  const find = typeof lookup === 'function' ? lookup : (id: string) => lookup.get(id);
  const missing = new Set<string>();
  const walk = (v: JsonValue): JsonValue => {
    if (typeof v === 'string') {
      if (!isWhombatId(v)) return v;
      const target = find(v);
      if (target === undefined) {
        missing.add(v);
        return v;
      }
      return target;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: { [key: string]: JsonValue } = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, missing: [...missing] };
}
