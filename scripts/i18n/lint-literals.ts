/**
 * Ratcheting JSX/TSX hardcoded-text check (docs/decisions/i18n.md I18N-10).
 *
 * Finds literal multi-word English sentences in TSX files under UI surfaces and compares
 * per-file counts against `scripts/i18n/lint-baseline.json`. Files can improve (fewer
 * hardcoded strings), never regress. Run with `--update-baseline` after translating screens.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
export const BASELINE_FILE = resolve(HERE, 'lint-baseline.json');

const SCAN_DIRS = ['apps/web/src', 'apps/mobile/src', 'apps/widget/src', 'appliance/console/ui/src'];

const IGNORE_RE = /(\.test\.tsx?$|\.stories\.tsx?$|\/i18n\/|\/locales\/|\/fixtures\/|\/mocks\/|\/vendor\/)/;
const JSX_TEXT_RE = />\s*([A-Z][A-Za-z’']+(?:\s+[A-Za-z’'-]+){2,}[.!?]?)\s*</g;
const ATTR_TEXT_RE = /\b(?:placeholder|aria-label|title)="([A-Z][A-Za-z’']+(?:\s+[A-Za-z’'-]+){1,}[.!?]?)"/g;

function walk(root: string, dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(root, full, out);
    else if (name.endsWith('.tsx') && !IGNORE_RE.test(`/${relative(root, full)}`)) out.push(full);
  }
}

export function scanLiteralCounts(
  root = ROOT,
  scanDirs: readonly string[] = SCAN_DIRS,
): Record<string, number> {
  const files: string[] = [];
  for (const d of scanDirs) walk(root, join(root, d), files);
  const counts: Record<string, number> = {};
  for (const file of files.sort()) {
    const src = readFileSync(file, 'utf8');
    let n = 0;
    for (const _ of src.matchAll(JSX_TEXT_RE)) n++;
    for (const _ of src.matchAll(ATTR_TEXT_RE)) n++;
    if (n > 0) counts[relative(root, file)] = n;
  }
  return counts;
}

export function lintLiterals({
  root = ROOT,
  scanDirs = SCAN_DIRS,
  baselinePath = BASELINE_FILE,
  updateBaseline = false,
}: {
  root?: string;
  scanDirs?: readonly string[];
  baselinePath?: string;
  updateBaseline?: boolean;
} = {}): {
  current: Record<string, number>;
  errors: string[];
} {
  if (!updateBaseline && !existsSync(baselinePath)) {
    return {
      current: {},
      errors: [
        `Missing i18n literal baseline at ${baselinePath}. Run pnpm exec tsx scripts/i18n/lint-literals.ts --update-baseline.`,
      ],
    };
  }
  const current = scanLiteralCounts(root, scanDirs);
  if (updateBaseline) {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    return { current, errors: [] };
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, number>;
  const errors: string[] = [];
  for (const [file, count] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) errors.push(`${file}: ${count} hardcoded string(s) (baseline ${allowed})`);
  }
  return { current, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const updateBaseline = process.argv.includes('--update-baseline');
  const { current, errors } = lintLiterals({ updateBaseline });
  if (errors.length > 0) {
    console.error('i18n literal check failed:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  const files = Object.keys(current).length;
  if (updateBaseline) {
    console.log(`Updated i18n literal baseline: ${files} file(s).`);
  } else {
    const total = Object.values(current).reduce((a, b) => a + b, 0);
    console.log(`i18n literal check ok (${total} tracked across ${files} file(s), 0 regressions).`);
  }
}
