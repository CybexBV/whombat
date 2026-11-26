/**
 * Decision ids stay findable (docs/decisions/decision-ids.md):
 *
 * - **clashes**: an id is defined (a table row's first cell, or a heading) in one decision file only, so a reader who
 *   looks one up finds one decision;
 * - **unresolved**: an id cited in code is written somewhere in the docs (directly, inside a range such as
 *   `OT-01…OT-12`, or as the decision a lettered id like `SG-15e` belongs to).
 *
 * The ids that broke these rules when the check came in are listed in `baseline.json`; anything new fails, and an entry
 * that no longer breaks them must leave the list. `pnpm decision-ids` prints the problems; `--write` rewrites the list.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A tree of files: their paths and a reader. */
export interface Tree {
  files: readonly string[];
  read(path: string): string;
}

export interface Findings {
  /** Ids defined in two or more decision files. */
  clashes: string[];
  /** Ids cited in code that no doc mentions. */
  unresolved: string[];
}

const ID = String.raw`[A-Z][A-Z0-9]{0,5}-(?:[A-Z]{1,3})?\d{1,5}[a-z]?`;
const TOKEN = new RegExp(String.raw`(?<![A-Za-z0-9_-])(${ID})(?![A-Za-z0-9_])`, 'g');
const RANGE = new RegExp(String.raw`(${ID})\s*[…–]\s*(${ID})`, 'g');
const DEFINITIONS = [
  new RegExp(String.raw`^\|\s*\**(${ID})\**\s*\|`),
  new RegExp(String.raw`^#{1,6}\s+\**(${ID})\b`),
];
const CODE = /\.(ts|tsx|js|mjs|cjs|py|go|sh|kt|swift)$/;
/** A whole ISO 3166-2 code (`NL-NB`; Austria's Länder are numbers): data, not a decision id, when it is a string. */
const ISO_3166_2 = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;
const QUOTES = new Set(["'", '"']);

/**
 * Whether the id at `index` of `text` is a whole string literal shaped as an ISO 3166-2 code: a region in a
 * table of news sites or a test, which shares its shape with a decision id but is none.
 */
export function isRegionCode(text: string, index: number, id: string): boolean {
  const before = text[index - 1] ?? '';
  return ISO_3166_2.test(id) && QUOTES.has(before) && text[index + id.length] === before;
}
const CODE_ROOTS = ['apps/', 'packages/', 'contracts/', 'tools/', 'scripts/'];

/** A decision file: one workstream's decisions (not its archive or history, not a spec that quotes them). */
const isActiveDecisionFile = (path: string) =>
  /^docs\/(app\/|contracts\/)?decisions\/[^/]+\.md$/.test(path) && !path.endsWith('/README.md');
const isDoc = (path: string) => path.endsWith('.md') && (path.startsWith('docs/') || !path.includes('/'));
const prefixOf = (id: string) => id.slice(0, id.indexOf('-'));

/** The ids a range spans (`DK-152…DK-156`, `HE-S10…HE-S12`): both ends share their prefix and letters. */
export function rangeIds(from: string, to: string): string[] {
  const a = /^(.+-)([A-Z]*)(\d+)$/.exec(from);
  const b = /^(.+-)([A-Z]*)(\d+)$/.exec(to);
  if (!a || !b || a[1] !== b[1] || a[2] !== b[2]) return [];
  const [lo, hi] = [Number(a[3]), Number(b[3])];
  if (hi < lo || hi - lo > 500) return [];
  const width = (a[3] as string).length;
  const out: string[] = [];
  for (let n = lo; n <= hi; n++) out.push(`${a[1]}${a[2]}${String(n).padStart(width, '0')}`);
  return out;
}

export function scan(tree: Tree): Findings {
  const definedIn = new Map<string, Set<string>>();
  const mentioned = new Set<string>();
  for (const path of tree.files) {
    if (!isDoc(path)) continue;
    const text = tree.read(path);
    for (const m of text.matchAll(TOKEN)) mentioned.add(m[1] as string);
    for (const m of text.matchAll(RANGE))
      for (const id of rangeIds(m[1] as string, m[2] as string)) mentioned.add(id);
    if (!isActiveDecisionFile(path)) continue;
    for (const line of text.split('\n')) {
      for (const p of DEFINITIONS) {
        const id = p.exec(line)?.[1];
        if (!id) continue;
        const files = definedIn.get(id) ?? new Set<string>();
        definedIn.set(id, files.add(path));
        break;
      }
    }
  }
  const prefixes = new Set([...definedIn.keys()].map(prefixOf));
  const clashes = [...definedIn].filter(([, files]) => files.size > 1).map(([id]) => id);
  const unresolved = new Set<string>();
  for (const path of tree.files) {
    if (!CODE.test(path) || !CODE_ROOTS.some((r) => path.startsWith(r))) continue;
    const text = tree.read(path);
    for (const m of text.matchAll(TOKEN)) {
      const id = m[1] as string;
      if (!prefixes.has(prefixOf(id)) || mentioned.has(id)) continue;
      if (isRegionCode(text, m.index, id)) continue;
      // A lettered id (`SG-15e`, `MA-21c`) belongs to its decision.
      if (/[a-z]$/.test(id) && mentioned.has(id.slice(0, -1))) continue;
      unresolved.add(id);
    }
  }
  return { clashes: clashes.sort(), unresolved: [...unresolved].sort() };
}

/** What `findings` has beyond `baseline` (new problems) and what `baseline` lists that is fixed now. */
export function compare(findings: Findings, baseline: Findings): { added: Findings; fixed: Findings } {
  const minus = (a: readonly string[], b: readonly string[]) => a.filter((x) => !b.includes(x));
  return {
    added: {
      clashes: minus(findings.clashes, baseline.clashes),
      unresolved: minus(findings.unresolved, baseline.unresolved),
    },
    fixed: {
      clashes: minus(baseline.clashes, findings.clashes),
      unresolved: minus(baseline.unresolved, findings.unresolved),
    },
  };
}

export const ROOT = resolve(import.meta.dirname, '../..');
export const BASELINE = join(import.meta.dirname, 'baseline.json');

/** This checkout's tracked files, read from disk. */
export function checkout(): Tree {
  const files = execFileSync('git', ['ls-files'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
  return { files, read: (path) => readFileSync(join(ROOT, path), 'utf8') };
}

export function readBaseline(): Findings {
  return JSON.parse(readFileSync(BASELINE, 'utf8')) as Findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = scan(checkout());
  if (process.argv.includes('--write')) {
    writeFileSync(BASELINE, `${JSON.stringify(findings, null, 2)}\n`);
    console.log(`baseline: ${findings.clashes.length} clashes, ${findings.unresolved.length} unresolved`);
  } else {
    const { added, fixed } = compare(findings, readBaseline());
    for (const id of added.clashes) console.log(`new clash: ${id} is defined in two decision files`);
    for (const id of added.unresolved)
      console.log(`unresolved: ${id} is cited in code but no doc mentions it`);
    for (const id of [...fixed.clashes, ...fixed.unresolved])
      console.log(`fixed: remove ${id} from baseline.json`);
  }
}
