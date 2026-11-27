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
const BASELINE_FILE = resolve(HERE, 'lint-baseline.json');

const SCAN_DIRS = ['apps/web/src', 'apps/mobile/src', 'apps/widget/src', 'appliance/console/ui/src'];

const IGNORE_RE = /(\.test\.tsx?$|\.stories\.tsx?$|\/i18n\/|\/locales\/|\/fixtures\/|\/mocks\/|\/vendor\/)/;
const JSX_TEXT_RE = />\s*([A-Z][A-Za-z’']+(?:\s+[A-Za-z’'-]+){2,}[.!?]?)\s*</g;
const ATTR_TEXT_RE = /\b(?:placeholder|aria-label|title)="([A-Z][A-Za-z’']+(?:\s+[A-Za-z’'-]+){1,}[.!?]?)"/g;

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.tsx') && !IGNORE_RE.test(full)) out.push(full);
  }
}

export function scanLiteralCounts(): Record<string, number> {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
  const counts: Record<string, number> = {};
  for (const file of files.sort()) {
    const src = readFileSync(file, 'utf8');
    let n = 0;
    for (const _ of src.matchAll(JSX_TEXT_RE)) n++;
    for (const _ of src.matchAll(ATTR_TEXT_RE)) n++;
    if (n > 0) counts[relative(ROOT, file)] = n;
  }
  return counts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const update = process.argv.includes('--update-baseline');
  const current = scanLiteralCounts();
  if (update || !existsSync(BASELINE_FILE)) {
    writeFileSync(BASELINE_FILE, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    console.log(`Updated i18n literal baseline: ${Object.keys(current).length} file(s).`);
    process.exit(0);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Record<string, number>;
  const regressions: string[] = [];
  for (const [file, count] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) regressions.push(`${file}: ${count} hardcoded string(s) (baseline ${allowed})`);
  }
  if (regressions.length > 0) {
    console.error(`i18n literal check found ${regressions.length} regression(s):`);
    for (const r of regressions) console.error(`  - ${r}`);
    process.exit(1);
  }
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  console.log(
    `i18n literal check ok (${total} tracked across ${Object.keys(current).length} file(s), 0 regressions).`,
  );
}
