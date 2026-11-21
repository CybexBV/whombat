/**
 * Tolerant decoding (CT-136, UP-B3b; kept in 1.0, CT-1262): within one session major a box and an app may be at different
 * minors (the hosted web app ships apart from the boxes), and a newer minor may add a union member or an enum value — a
 * new card kind, work item kind or event type. A client decodes such an answer by leaving out the item that carries it
 * and reporting it, instead of failing the whole answer.
 *
 * Use it for session operation outputs, events and control responses. Never for commands (strict inputs) or signed,
 * hashed and security documents: those stay strict (CT-14).
 */
import type { z } from 'zod';

type Path = readonly PropertyKey[];
type Issue = z.core.$ZodIssue;

/** One item `decodeTolerant` left out. */
export interface SkippedItem {
  /** Where the item was in the value given (list indexes and member names). */
  path: (string | number)[];
  /** The value this version doesn't know (an enum member or a union's discriminator). */
  value: string;
  /** `dropped` from its list, `unset` (an optional member), `nulled` (a nullable member). */
  action: 'dropped' | 'unset' | 'nulled';
}

export type TolerantResult<T> =
  | { ok: true; data: T; skipped: SkippedItem[] }
  /** `error` is the plain parse's error, as `safeParse` gives it. */
  | { ok: false; error: z.ZodError };

/** At most this many items are left out of one value (then it fails as a plain parse would). */
export const TOLERANT_MAX_REPAIRS = 256;
const MAX_ROUNDS = 8;

const isRecord = (v: unknown): v is Record<PropertyKey, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function getAt(root: unknown, path: Path): unknown {
  let v = root;
  for (const k of path) {
    if (Array.isArray(v) && typeof k === 'number') v = v[k];
    else if (isRecord(v)) v = v[k];
    else return undefined;
  }
  return v;
}

/** Copy-on-write update of the value at `path`; the value as it is when the path isn't there (any more). */
function update(root: unknown, path: Path, fn: (v: unknown) => unknown): unknown {
  if (path.length === 0) return fn(root);
  const [k, ...rest] = path as [PropertyKey, ...PropertyKey[]];
  if (Array.isArray(root) && typeof k === 'number') {
    if (k >= root.length) return root;
    const copy = root.slice();
    copy[k] = update(root[k], rest, fn);
    return copy;
  }
  if (isRecord(root) && Object.hasOwn(root, k)) return { ...root, [k]: update(root[k], rest, fn) };
  return root;
}

const startsWith = (path: Path, prefix: Path) =>
  prefix.length <= path.length && prefix.every((k, i) => k === path[i]);

/** Document order, list indexes numerically: drops in descending order keep earlier indexes valid. */
function comparePaths(a: Path, b: Path): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return a.length - b.length;
}

interface Unknown {
  /** The value that carries the unknown member: the enum value itself, or the object with the discriminator. */
  carrier: Path;
  value: string;
}

/** What an issue is about when it is only an unknown enum member or union discriminator; null otherwise. */
function unknownOf(issue: Issue, input: unknown): Unknown | null {
  if (issue.code === 'invalid_value') {
    const v = getAt(input, issue.path);
    return typeof v === 'string' ? { carrier: issue.path, value: v } : null;
  }
  if (issue.code !== 'invalid_union') return null;
  const disc = (issue as { discriminator?: unknown }).discriminator;
  if (typeof disc === 'string') {
    // zod reports a discriminated union's unknown discriminator at `<object>.<discriminator>`.
    const carrier = issue.path.at(-1) === disc ? issue.path.slice(0, -1) : issue.path;
    const v = getAt(input, [...carrier, disc]);
    return typeof v === 'string' ? { carrier, value: v } : null;
  }
  // A plain union: tolerable when every option failed only on unknown members (sub-issue paths are relative).
  const at = getAt(input, issue.path);
  if (issue.errors.length === 0) return null;
  let value: string | null = null;
  for (const branch of issue.errors) {
    if (branch.length === 0) return null;
    for (const sub of branch) {
      const u = unknownOf(sub, at);
      if (!u) return null;
      value ??= u.value;
    }
  }
  return value === null ? null : { carrier: issue.path, value };
}

/**
 * Whether a parse issue is one `decodeTolerant` repairs: an enum member (or string literal) this version doesn't know,
 * or a union's unknown discriminator. `input` is the value the issue's path refers to.
 */
export function isTolerableIssue(issue: Issue, input: unknown): boolean {
  return unknownOf(issue, input) !== null;
}

interface Target {
  at: Path;
  value: string;
}

/** Keeps one target per location, and none inside another's. */
const dedupe = (targets: Target[]): Target[] =>
  targets.filter(
    (t, i) =>
      !targets.some(
        (o, j) =>
          (o.at.length < t.at.length && startsWith(t.at, o.at)) ||
          (j < i && o.at.length === t.at.length && startsWith(t.at, o.at)),
      ),
  );

const toPath = (p: Path) => p.map((k) => (typeof k === 'number' ? k : String(k)));

/**
 * Parses `value` with `schema`; when that fails only because of unknown enum members or union discriminators
 * (`isTolerableIssue`), repairs and parses again: the list element that carries the unknown value is dropped, an
 * optional member holding it is unset and a nullable one set to null — the nearest of these, walking up from the
 * unknown value — and every repair is reported in `skipped`. Anything else fails with the plain parse's error, as
 * does a value that would need more than `maxRepairs` repairs or whose repair reaches the top. Unknown object members
 * are stripped by the schemas already (CT-14).
 */
export function decodeTolerant<S extends z.ZodType>(
  schema: S,
  value: unknown,
  opts: { maxRepairs?: number } = {},
): TolerantResult<z.output<S>> {
  const first = schema.safeParse(value);
  if (first.success) return { ok: true, data: first.data, skipped: [] };
  const fail = { ok: false as const, error: first.error };
  const max = opts.maxRepairs ?? TOLERANT_MAX_REPAIRS;
  const skipped: SkippedItem[] = [];
  let input = value;
  let issues = first.error.issues;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const found: Target[] = [];
    for (const issue of issues) {
      const u = unknownOf(issue, input);
      if (!u) return fail;
      found.push({ at: u.carrier, value: u.value });
    }
    let open = dedupe(found);
    if (skipped.length + open.length > max) return fail;
    // Decide every repair before applying one, so list indexes stay those of the value given.
    const drops: Target[] = [];
    const members: (Target & { action: 'unset' | 'nulled' })[] = [];
    while (open.length > 0) {
      const next: Target[] = [];
      for (const t of open) {
        if (t.at.length === 0) return fail;
        const parent = getAt(input, t.at.slice(0, -1));
        if (Array.isArray(parent) && typeof t.at.at(-1) === 'number') drops.push(t);
        else if (isRecord(parent)) next.push(t);
        else return fail;
      }
      open = next;
      for (const action of ['unset', 'nulled'] as const) {
        if (open.length === 0) break;
        const set = (root: unknown, ts: Target[]) =>
          ts.reduce(
            (r, t) =>
              update(r, t.at.slice(0, -1), (p) => {
                const copy = { ...(p as Record<PropertyKey, unknown>) };
                if (action === 'unset') delete copy[t.at.at(-1) as PropertyKey];
                else copy[t.at.at(-1) as PropertyKey] = null;
                return copy;
              }),
            root,
          );
        const trial = schema.safeParse(set(input, open));
        const accepted = open.filter(
          (t) => trial.success || !trial.error.issues.some((i) => startsWith(i.path, t.at)),
        );
        for (const t of accepted) members.push({ ...t, action });
        open = open.filter((t) => !accepted.includes(t));
      }
      open = dedupe(open.map((t) => ({ ...t, at: t.at.slice(0, -1) })));
    }
    for (const m of members) {
      input = update(input, m.at.slice(0, -1), (p) => {
        if (!isRecord(p)) return p;
        const copy = { ...p };
        if (m.action === 'unset') delete copy[m.at.at(-1) as PropertyKey];
        else copy[m.at.at(-1) as PropertyKey] = null;
        return copy;
      });
      skipped.push({ path: toPath(m.at), value: m.value, action: m.action });
    }
    for (const d of dedupe(drops).sort((a, b) => comparePaths(b.at, a.at))) {
      const i = d.at.at(-1) as number;
      input = update(input, d.at.slice(0, -1), (p) => (Array.isArray(p) ? p.filter((_, j) => j !== i) : p));
      skipped.push({ path: toPath(d.at), value: d.value, action: 'dropped' });
    }
    const again = schema.safeParse(input);
    if (again.success) return { ok: true, data: again.data, skipped };
    issues = again.error.issues;
  }
  return fail;
}
