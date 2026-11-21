/**
 * `pnpm notices` — writes THIRD_PARTY_NOTICES.md from this checkout's tracked files and the licences of its production
 * dependencies (`pnpm licenses list --prod`); what it says and what it requires is `scripts/notices/notices.ts`.
 * `pnpm notices --check` fails when the file is out of date, and both fail when something third-party in the tree isn't
 * described there. Never edit the file by hand.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildNotices, type LicensedPackage } from './notices/notices';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'THIRD_PARTY_NOTICES.md');
const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });

const run = (command: string, args: string[]) =>
  execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

const files = run('git', ['ls-files']).split('\n').filter(Boolean);
const licences = JSON.parse(run('pnpm', ['licenses', 'list', '--prod', '--json'])) as Record<
  string,
  LicensedPackage[]
>;
const notices = buildNotices({ files, read: (path) => readFileSync(join(ROOT, path), 'utf8') }, licences);

if (notices.problems.length > 0) {
  console.error(
    `THIRD_PARTY_NOTICES.md: describe these in scripts/notices/notices.ts first:\n- ${notices.problems.join('\n- ')}`,
  );
  process.exit(1);
}
if (values.check) {
  if (readFileSync(OUT, 'utf8') !== notices.text) {
    console.error('THIRD_PARTY_NOTICES.md is out of date: run `pnpm notices`.');
    process.exit(1);
  }
} else {
  writeFileSync(OUT, notices.text);
  console.log(`THIRD_PARTY_NOTICES.md: ${notices.dependencies} dependencies`);
}
