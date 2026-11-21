/**
 * Real SQL hydration benchmark, isolated in a migrated throwaway database on the existing Postgres.
 * node --import tsx scripts/benchmarks/automation-runs.ts --baseline-ref b37fe2cc3 --output-dir /path/to/evidence
 * The reference store is captured before timing; its imports resolve against this checkout's unchanged dependencies.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, cpus, hostname, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as current from '../../apps/server/src/automations/store';
import { runReadDb, seedRunReadWorkload } from '../../apps/server/src/automations/testing/run-reads';
import { createTestDb } from '../../apps/server/src/test/db-resource';

const { values } = parseArgs({
  options: { 'baseline-ref': { type: 'string' }, 'output-dir': { type: 'string' } },
});
const root = resolve(import.meta.dirname, '../..');
const output = values['output-dir'] ?? (await mkdtemp(join(tmpdir(), 'whombat-run-bench-')));
await mkdir(output, { recursive: true });
let baseline: typeof current | undefined;
if (values['baseline-ref']) {
  const file = 'apps/server/src/automations/store.ts';
  const source = execFileSync('git', ['show', `${values['baseline-ref']}:${file}`], {
    cwd: root,
    encoding: 'utf8',
  });
  const require = createRequire(join(root, 'apps/server/package.json'));
  const captured = source.replace(/from (['"])([^'"]+)\1/g, (_, _quote, specifier: string) => {
    const target = specifier.startsWith('.')
      ? resolve(root, dirname(file), specifier)
      : require.resolve(specifier).replace(/\.cjs$/, '.js');
    return `from '${pathToFileURL(target).href}'`;
  });
  const module = join(output, 'automation-store-baseline.mts');
  await writeFile(module, captured);
  baseline = await import(pathToFileURL(module).href);
}

const fixture = await createTestDb(3);
const queryLog: string[] = [];
const db = runReadDb(fixture.sql, queryLog);
try {
  const [postgres] = await fixture.sql<{ server_version: string }[]>`show server_version`;
  const rows = await seedRunReadWorkload(db, 200);
  await fixture.sql`analyze automation_run_steps`;
  await fixture.sql`analyze dispatches`;
  await fixture.sql`analyze runs`;
  const batched = (
    current as unknown as {
      toRuns?: (
        database: typeof db,
        input: typeof rows,
      ) => Promise<Awaited<ReturnType<typeof current.toRun>>[]>;
    }
  ).toRuns;
  async function readOld(input: typeof rows) {
    return Promise.all(input.map((row) => (baseline ?? current).toRun(db, row)));
  }
  const readNew = batched ? (input: typeof rows) => batched(db, input) : readOld;
  const measurements = [];
  for (const size of [1, 30, 200]) {
    const input = rows.slice(0, size).reverse();
    const before = await readOld(input);
    const after = await readNew(input);
    assert.deepEqual(after, before);
    const expected = JSON.stringify(before);
    await writeFile(
      join(output, `automation-runs-${batched ? 'after' : 'before'}-${size}-expected.json`),
      `${expected}\n`,
    );
    for (let i = 0; i < 5; i++) {
      await readOld(input);
      await readNew(input);
    }
    const samples: Record<string, { ms: number; queries: number }[]> = { baseline: [], current: [] };
    for (let i = 0; i < 11; i++) {
      for (const name of i % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        queryLog.length = 0;
        const start = performance.now();
        const result = await (name === 'baseline' ? readOld(input) : readNew(input));
        const ms = performance.now() - start;
        assert.equal(JSON.stringify(result), expected);
        samples[name]?.push({ ms, queries: queryLog.length });
      }
    }
    const summary = Object.fromEntries(
      Object.entries(samples).map(([name, items]) => {
        const sorted = items.map((x) => x.ms).sort((a, b) => a - b);
        return [
          name,
          { medianMs: sorted[5], minMs: sorted[0], maxMs: sorted[10], queries: items[0]?.queries },
        ];
      }),
    );
    measurements.push({
      size,
      outputSha256: createHash('sha256').update(expected).digest('hex'),
      summary,
      samples,
    });
  }
  const report = {
    environment: {
      node: process.version,
      postgres: postgres?.server_version,
      platform: platform(),
      arch: arch(),
      hostname: hostname(),
      cpu: cpus()[0]?.model,
    },
    baselineRef: values['baseline-ref'] ?? null,
    currentSourceSha256: createHash('sha256')
      .update(await readFile(join(root, 'apps/server/src/automations/store.ts')))
      .digest('hex'),
    batched: !!batched,
    database: fixture.name,
    poolSize: 3,
    fixture: {
      automations: 4,
      runs: 200,
      stepsPerRun: 4,
      dispatchesPerRun: 2,
      codeRunsPerRun: 2,
      approvalsPerRun: 1,
    },
    warmups: 5,
    runs: 11,
    measurements,
  };
  await writeFile(
    join(output, batched ? 'automation-runs-after.json' : 'automation-runs-before.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await fixture.drop();
  if (!values['output-dir']) await rm(output, { recursive: true, force: true });
}
