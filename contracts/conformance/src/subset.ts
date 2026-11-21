/**
 * Enforces the supported cross-language schema subset (docs/contracts/cross-language.md) on Zod schemas, so that the
 * JSON Schema export and the Go validators accept exactly what Zod accepts.
 */
import {
  KIT_APPLIANCE_NAME_RE,
  PUSH_PREVIEW_BODY_RE,
  PUSH_PREVIEW_TITLE_RE,
} from '@whombat/control-contracts/device';
import { CONSOLE_DISPLAY_TEXT_RE, DESK_TEXT_RES } from '@whombat/control-contracts/local';
import { BACKUP_REASON_RE, HOST_TEXT_RES } from '@whombat/protocol/session';
import type { z } from 'zod';

type Def = { type: string; [k: string]: unknown };
type Check = { _zod: { def: { check: string; [k: string]: unknown } } };
const defOf = (s: unknown): Def => (s as { _zod: { def: Def } })._zod.def;
const checksOf = (d: Def): Check['_zod']['def'][] =>
  ((d.checks as Check[] | undefined) ?? []).map((c) => c._zod.def);

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * The Unicode patterns admitted by name (CT-116), with the `u` flag: they use only general categories whose tables
 * agree between ECMAScript and Go RE2 (`Cc`, `Cf`, `Cs`, `Z`; the conformance test compares them), negated classes of
 * those, a literal space and counted groups, and they carry their length in the pattern (code points on both sides),
 * so the string may not also carry `.min`/`.max` (UTF-16 units in Zod, code points in JSON Schema).
 */
export const UNICODE_PATTERNS: readonly RegExp[] = [
  CONSOLE_DISPLAY_TEXT_RE,
  PUSH_PREVIEW_TITLE_RE,
  PUSH_PREVIEW_BODY_RE,
  // The desk's display text (0.100, CT-529), the push previews' form at the desk's lengths.
  ...DESK_TEXT_RES,
  // The hardware report's and the network's display text (0.102, CT-560), the same form at their lengths.
  ...HOST_TEXT_RES,
  // The backup service's reasons for people (Whombat backup-options.md CT-1696), the same form at 500.
  BACKUP_REASON_RE,
  // A Whombat's name in the envelope push (Whombat backup-passkey.md CT-1710), the console's form at 80.
  KIT_APPLIANCE_NAME_RE,
];
const isUnicodePattern = (re: RegExp) =>
  UNICODE_PATTERNS.some((u) => u.source === re.source && u.flags === re.flags);

/**
 * Regex rules: anchored `^…$`, ASCII only, no flags, no lookaround/backreferences/named groups, no negated
 * classes, no `.`, no shorthand classes (`\s`, `\d`, `\w`, …) — so every match is ASCII (lengths agree between
 * UTF-16 and code points) and the pattern means the same in ECMAScript and Go RE2.
 */
export function checkPattern(re: RegExp): string | null {
  const src = re.source;
  if (isUnicodePattern(re)) return null;
  if (re.flags !== '') return `flags /${re.flags}/`;
  if (!src.startsWith('^') || !src.endsWith('$')) return 'not anchored';
  if (/[^\x20-\x7e]/.test(src)) return 'non-ASCII pattern';
  if (/\(\?/.test(src)) return 'group syntax (?…)';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1] ?? '';
      if (/[sSdDwWbBpPkuc0-9]/.test(n)) return `escape \\${n}`;
      if (n === 'x') {
        if (!/^[0-7][0-9a-fA-F]$/.test(src.slice(i + 2, i + 4))) return 'non-ASCII \\x escape';
        i += 3;
        continue;
      }
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      if (src[i + 1] === '^') return 'negated class';
      inClass = true;
      continue;
    }
    if (c === '.') return 'unescaped .';
  }
  return null;
}

export function checkSubset(schema: z.ZodType, path = '$'): string[] {
  const errors: string[] = [];
  const err = (m: string, at = path) => errors.push(`${at}: ${m}`);

  const walk = (s: unknown, at: string, ctx: { property?: boolean; recordValue?: boolean } = {}) => {
    const d = defOf(s);
    const checks = checksOf(d);
    switch (d.type) {
      case 'string': {
        if (d.format !== undefined && d.format !== 'regex')
          return err(`string format ${String(d.format)}`, at);
        let hasPattern = false;
        const lengths = checks.some((c) => c.check === 'min_length' || c.check === 'max_length');
        for (const c of checks) {
          if (c.check === 'min_length' || c.check === 'max_length') continue;
          if (c.check === 'string_format' && c.format === 'regex') {
            hasPattern = true;
            if (isUnicodePattern(c.pattern as RegExp) && lengths)
              err('a Unicode pattern carries its length; no .min/.max', at);
            const bad = checkPattern(c.pattern as RegExp);
            if (bad) err(`pattern ${String(c.pattern)}: ${bad}`, at);
            continue;
          }
          err(`string check ${c.check}${c.format ? `(${String(c.format)})` : ''}`, at);
        }
        if (!hasPattern) err('string without an ASCII pattern', at);
        return;
      }
      case 'number': {
        let int = false;
        let min: number | undefined;
        let max: number | undefined;
        for (const c of checks) {
          if (c.check === 'number_format' && c.format === 'safeint') int = true;
          else if (c.check === 'greater_than' && c.inclusive) min = c.value as number;
          else if (c.check === 'less_than' && c.inclusive) max = c.value as number;
          else err(`number check ${c.check}`, at);
        }
        if (!int) err('non-integer number', at);
        if (min === undefined || max === undefined) err('integer without inclusive min and max', at);
        else if (min < -MAX_SAFE || max > MAX_SAFE) err('integer bounds beyond ±(2^53−1)', at);
        return;
      }
      case 'boolean':
        if (checks.length) err('boolean checks', at);
        return;
      case 'literal': {
        const values = d.values as unknown[];
        if (values.length !== 1 || !['string', 'number', 'boolean'].includes(typeof values[0]))
          err('literal must be one string/number/boolean', at);
        if (typeof values[0] === 'number' && !Number.isSafeInteger(values[0])) err('non-integer literal', at);
        return;
      }
      case 'enum':
        if (!Object.values(d.entries as object).every((v) => typeof v === 'string'))
          err('non-string enum', at);
        return;
      case 'array': {
        const has = (k: string) => checks.some((c) => c.check === k);
        for (const c of checks)
          if (c.check !== 'min_length' && c.check !== 'max_length') err(`array check ${c.check}`, at);
        if (!has('max_length')) err('array without maxItems', at);
        walk(d.element, `${at}[]`);
        return;
      }
      case 'object': {
        const catchall = d.catchall ? defOf(d.catchall).type : 'strip';
        // CT-14: `z.strictObject` (command inputs, signed documents, tokens) rejects unknown members;
        // `z.object` (wire messages, responses) strips them — Go strips with exact-case matching
        // (`internal/schemas.Decode`), so `KID` can't shadow `kid`. `z.looseObject` would keep unknown members
        // in the TypeScript output, which Go can't mirror.
        if (catchall !== 'never' && catchall !== 'strip')
          err(`object must be z.strictObject or z.object, not ${catchall}`, at);
        if (checks.length) err('object refinements', at);
        for (const [k, v] of Object.entries(d.shape as Record<string, unknown>))
          walk(v, `${at}.${k}`, { property: true });
        return;
      }
      case 'optional': {
        if (!ctx.property) err('optional outside an object property', at);
        const inner = defOf(d.innerType).type;
        if (inner === 'nullable' || inner === 'optional') err('optional of nullable/optional', at);
        walk(d.innerType, at);
        return;
      }
      case 'nullable': {
        const inner = defOf(d.innerType).type;
        if (inner === 'nullable' || inner === 'optional') err('nullable of nullable/optional', at);
        walk(d.innerType, at);
        return;
      }
      case 'union': {
        if (typeof d.discriminator !== 'string') return err('union without a discriminator', at);
        for (const [i, o] of (d.options as unknown[]).entries()) {
          const od = defOf(o);
          if (od.type !== 'object') err('discriminated union option is not an object', `${at}|${i}`);
          walk(o, `${at}|${i}`);
        }
        return;
      }
      case 'record': {
        if (defOf(d.keyType).type !== 'string' || checksOf(defOf(d.keyType)).length)
          err('record keys must be plain strings', at);
        if (defOf(d.valueType).type !== 'unknown')
          err('record values must be unknown (opaque JSON object)', at);
        walk(d.valueType, `${at}{}`, { recordValue: true });
        return;
      }
      case 'unknown':
        if (!ctx.recordValue) err('unknown outside an opaque record', at);
        return;
      default:
        err(`unsupported ${d.type}`, at);
    }
  };
  walk(schema, path);
  return errors;
}
