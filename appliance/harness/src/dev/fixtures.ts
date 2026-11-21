/**
 * Test-only runtime builds for the migration cases of slice C (IN-25). A fixture is a clean clone of the pinned
 * runtime commit under `~/.cache/whombat-mgd/fixtures/` with a harness-side patch applied in that scratch copy only
 * (never committed to Whombat): one extra migration and a distinct, higher version string, so the manager can tell the
 * binaries apart.
 *
 * - `expand`: `NNNN_harness_fixture_expand` creates a table; class `expand`, reader and writer floors at the
 *   previous migration, so the older binary keeps reading and writing (rollback-compatible).
 * - `contract`: the expand migration plus `NNNN_harness_fixture_contract`, which drops a column; class `contract`,
 *   floors past the base binary, so it needs a verified checkpoint and the base binary can't run after it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanClone, isClean } from '../lib/git.ts';
import { paths } from '../lib/paths.ts';
import { must } from '../lib/proc.ts';
import type { SourceState } from './env.ts';
import { touchCopy } from './prune-copies.ts';

export type FixtureKind = 'expand' | 'contract';

export interface RuntimeFixture {
  kind: FixtureKind;
  dir: string;
  version: string;
  tags: string[];
}

const MIGRATIONS = 'apps/server/src/db/migrations';

function patch(dir: string, kind: FixtureKind, baseVersion: string): RuntimeFixture {
  const journalFile = join(dir, MIGRATIONS, 'meta', '_journal.json');
  const compatFile = join(dir, MIGRATIONS, 'compat.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
  };
  const compat = JSON.parse(readFileSync(compatFile, 'utf8')) as {
    runtime: { readsFrom: string; writesFrom: string };
    migrations: Record<string, Record<string, string>>;
  };
  const last = journal.entries.at(-1);
  if (!last) throw new Error('no migrations');
  const add = (tag: string, sql: string, entry: Record<string, string>) => {
    const idx = (journal.entries.at(-1)?.idx ?? 0) + 1;
    writeFileSync(join(dir, MIGRATIONS, `${tag}.sql`), sql);
    journal.entries.push({ idx, version: last.version, when: last.when + idx, tag, breakpoints: true });
    compat.migrations[tag] = entry;
    return tag;
  };
  const n = (i: number) => String(last.idx + i).padStart(4, '0');
  const expandTag = add(
    `${n(1)}_harness_fixture_expand`,
    'CREATE TABLE "harness_fixture" (\n\t"id" serial PRIMARY KEY NOT NULL,\n\t"note" text\n);\n',
    { class: 'expand', readers: last.tag, writers: last.tag },
  );
  const tags = [expandTag];
  if (kind === 'contract')
    tags.push(
      add(`${n(2)}_harness_fixture_contract`, 'ALTER TABLE "harness_fixture" DROP COLUMN "note";\n', {
        class: 'contract',
        readers: expandTag,
        writers: `${n(2)}_harness_fixture_contract`,
      }),
    );
  const newest = tags.at(-1) as string;
  compat.runtime = { readsFrom: newest, writesFrom: newest };
  writeFileSync(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
  writeFileSync(compatFile, `${JSON.stringify(compat, null, 2)}\n`);
  const pkgFile = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { version: string };
  pkg.version = fixtureVersion(baseVersion, kind);
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(
    join(dir, 'HARNESS-FIXTURE.txt'),
    `Test-only runtime build (the appliance's harness, IN-25): ${kind} migration ${tags.join(', ')} added to a scratch clone.\nNever a product build; never committed to Whombat.\n`,
  );
  return { kind, dir, version: pkg.version, tags };
}

/**
 * A fixture's version sorts above its base and contract above expand (the manager refuses downgrades,
 * security-fixes-2): `<major>.<minor>.<patch+1>-fixture.<1|2>.<kind>` (IN-29).
 */
export function fixtureVersion(base: string, kind: FixtureKind): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(base);
  if (!m) throw new Error(`runtime version ${base} is not semver`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}-fixture.${kind === 'expand' ? 1 : 2}.${kind}`;
}

/** Fixture layout generation: a change invalidates fixtures built by an older harness. */
const FIXTURE_FORMAT = 2;

/** Builds (once per runtime commit) and returns the fixture. */
export async function runtimeFixture(
  runtime: SourceState,
  kind: FixtureKind,
  source: string,
): Promise<RuntimeFixture> {
  const dir = join(
    paths.home,
    'fixtures',
    `runtime-${kind}@${runtime.commit.slice(0, 12)}-f${FIXTURE_FORMAT}`,
  );
  const meta = join(dir, '.harness-fixture.json');
  if (existsSync(meta)) {
    touchCopy(dir);
    return JSON.parse(readFileSync(meta, 'utf8')) as RuntimeFixture;
  }
  mkdirSync(join(paths.home, 'fixtures'), { recursive: true });
  await cleanClone(source, runtime.commit, dir);
  if (!(await isClean(dir))) throw new Error(`${dir} is not clean`);
  const baseVersion = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string })
    .version;
  const fx = patch(dir, kind, baseVersion);
  await must('pnpm', ['install', '--frozen-lockfile'], {
    cwd: dir,
    logFile: join(paths.logs, `fixture-${kind}.log`),
    timeoutMs: 1_800_000,
  });
  writeFileSync(meta, `${JSON.stringify(fx, null, 2)}\n`);
  return fx;
}
