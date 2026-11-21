/**
 * `harness/validate` — the main validation suite (R-75, IN-13):
 *
 *   1. the product manifest is valid and names the pinned commits (`manifest/validate`);
 *   2. each repository's own gates from the pinned commit, in a fresh clean clone (`pins.json` gates: contracts
 *      `pnpm check` + Go tests, relay `make test`, control `pnpm check` + `pnpm test:int`, Whombat `pnpm check` +
 *      `pnpm test:server`, app `pnpm check`, appliance Go tests), Postgres-backed ones on the harness's own
 *      container;
 *   3. the harness's own checks (`pnpm check` in harness/);
 *   4. the cross-repo scenarios against the local integrated environment (started with `dev/up` when not running).
 *
 * Writes `harness/reports/<timestamp>/report.{json,md}` (exact commands, versions, durations, outcomes, logs) and
 * copies the summary to `harness/reports/latest.{json,md}` (the only committed report files).
 *
 *   harness/validate [--no-build] [--skip-gates] [--gates id,id] [--skip-scenarios] [--scenarios pattern] [--jobs N] [--live [app,runtime,…]] [--soak 30m] [--reuse-env]
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { stopAll } from '../dev/down.ts';
import { loadEnv } from '../dev/env.ts';
import { ensureDatabase, ensurePostgres } from '../dev/postgres.ts';
import { REST_SERVER_VERSION } from '../dev/services.ts';
import type { LiveSelection } from '../dev/sources.ts';
import { liveArg, up } from '../dev/up.ts';
import { cleanClone } from '../lib/git.ts';
import { sha256File } from '../lib/hash.ts';
import { acquireEnvLock } from '../lib/lock.ts';
import {
  agentsMode,
  HARNESS_DIR,
  PG_CONTAINER,
  paths,
  pgUrl,
  ports,
  publicUrls,
  REPORTS_DIR,
  STATE_HOME,
} from '../lib/paths.ts';
import { run } from '../lib/proc.ts';
import { buildAll } from '../manifest/build.ts';
import { validateManifest } from '../manifest/check.ts';
import { type Component, loadPins, MANIFEST_FILES, PINS_FILE, rootIn, sourceOf } from '../manifest/pins.ts';
import {
  gateKey,
  gateRunnerFingerprint,
  pruneGateCache,
  readGateCache,
  saveGateCache,
} from './gate-cache.ts';
import { gateCoverage, gateId } from './gate-coverage.ts';
import { renderMarkdown } from './render.ts';
import {
  busyPorts,
  isolatedScenarioFiles,
  PORT_VARIABLES,
  ShardReport,
  scenarioEnv,
} from './scenario-groups.ts';
import { APP_TERMS, termsGate } from './terms.ts';

export function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h)?$/.exec(s.trim());
  if (!m?.[1]) throw new Error(`bad duration ${s} (e.g. 30m, 90s, 1h)`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 'm') as 's' | 'm' | 'h'];
}

export interface GateResult {
  component: string;
  repository: string;
  commit: string;
  gate: string;
  command: string;
  cwd: string;
  outcome: 'passed' | 'failed' | 'timeout' | 'not-run';
  exitCode: number | null;
  durationMs: number;
  log: string;
  summary: string;
  reused?: { key: string; finishedAt: string; durationMs: number };
  coveredBy?: { component: string; gate: string; command: string };
}

export interface ScenarioResult {
  file: string;
  name: string;
  outcome: 'passed' | 'failed' | 'blocked' | 'skipped';
  durationMs: number;
  blocked?: string;
  error?: string;
}

export interface ValidationReport {
  $schema: 'whombat.validation-report/1';
  runId: string;
  startedAt: string;
  finishedAt: string;
  host: Record<string, string>;
  manifest: { ok: boolean; problems: string[]; summary: string[]; productVersion: string; pinsFile: string };
  pins: { id: string; repository: string; ref: string; commit: string }[];
  environment: { mode: string; sources: Record<string, string> } | null;
  gates: GateResult[];
  harness: GateResult | null;
  scenarios: ScenarioResult[];
  records: Record<string, unknown>[];
  measurements: Record<string, unknown>[];
  gaps: Record<string, unknown>[];
  /** `--soak`: resident memory of each service under steady traffic (IN-23). */
  soak: Record<string, unknown> | null;
  totals: Record<string, number>;
  ok: boolean;
}

/** One-line summary of a test runner's output (counts), else the last line. */
function summarize(out: string): string {
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const pick = lines.filter((l) =>
    /(Test Files|Tests)\s+\d|^ok\s|^FAIL|^---\s*FAIL|passed|failed|^PASS/.test(l),
  );
  const vitest = lines.filter((l) => /^(Test Files|Tests)\s/.test(l));
  if (vitest.length) return vitest.join(' · ');
  const goOk = lines.filter((l) => /^ok\s/.test(l)).length;
  const goFail = lines.filter((l) => /^(FAIL|--- FAIL)/.test(l)).length;
  if (goOk || goFail) return `go: ${goOk} packages ok, ${goFail} FAIL lines`;
  return (pick.at(-1) ?? lines.at(-1) ?? '').slice(0, 200);
}

export async function runGates(
  pins: Component[],
  runDir: string,
  only: string[] | null,
  jobs: number,
  log: (l: string) => void,
  cache: { root: string; enabled: boolean; setup: Record<string, string> },
): Promise<GateResult[]> {
  const scratch = join(paths.scratch, `validate-${relative(REPORTS_DIR, runDir)}`);
  const results: GateResult[] = [];
  const queue = pins.filter(
    (c) =>
      c.gates.length &&
      (!only || only.some((o) => o === c.id || c.gates.some((g) => `${c.id}:${g.id}` === o))),
  );
  const restServer = join(paths.bin, `rest-server-${REST_SERVER_VERSION}`, 'rest-server');
  const coverage = gateCoverage(pins, only);
  const roots = new Set([...coverage.values()].map((g) => g.component));
  queue.sort((a, b) => Number(roots.has(b.id)) - Number(roots.has(a.id)));
  const completed = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const rootScopes = new Map<string, Set<string>>();
  for (const c of queue) {
    let finish = () => {};
    const promise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    completed.set(c.id, { promise, resolve: finish });
  }
  const one = async (c: Component) => {
    const dir = join(scratch, c.id);
    const logFile = join(runDir, 'logs', `${c.id}.log`);
    if (roots.has(c.id)) {
      // A new nested Go module would fall outside root ./...; inspect the exact source tree before covering it.
      // The component's own tree: its folder of the commit when the commit holds it there (the appliance in the one
      // repository), else the commit.
      const inFolder =
        c.dir !== undefined &&
        (await run('git', ['cat-file', '-e', `${c.commit}:${c.dir}/go.mod`], { cwd: sourceOf(c) })).code ===
          0;
      const layout = await run(
        'git',
        [
          'ls-tree',
          '--name-only',
          inFolder ? `${c.commit}:${c.dir}` : c.commit,
          '--',
          'go.mod',
          'backup/go.mod',
          'provisioning/go.mod',
        ],
        { cwd: sourceOf(c), timeoutMs: 30_000 },
      );
      const files = new Set(layout.stdout.trim().split('\n'));
      rootScopes.set(
        c.id,
        new Set(
          layout.code === 0 && files.has('go.mod')
            ? ['backup', 'provisioning'].filter((name) => !files.has(`${name}/go.mod`))
            : [],
        ),
      );
    }
    const selected = c.gates.filter((g) => !only || only.includes(c.id) || only.includes(`${c.id}:${g.id}`));
    const pending: Component['gates'] = [];
    for (const g of selected) {
      const root = coverage.get(gateId(c.id, g.id));
      if (root) {
        await completed.get(root.component)?.promise;
        const checked = results.find((r) => r.component === root.component && r.gate === root.gate);
        if (checked?.outcome === 'passed' && rootScopes.get(root.component)?.has(g.cwd)) {
          results.push({
            ...checked,
            component: c.id,
            gate: g.id,
            cwd: g.cwd,
            command: g.run.join(' '),
            durationMs: 0,
            coveredBy: { ...root, command: checked.command },
          });
          log(`gate ${c.id}:${g.id} covered by successful ${root.component}:${root.gate} at the same commit`);
          continue;
        }
      }
      const key = gateKey(c, g, cache.setup);
      const hit = cache.enabled ? readGateCache(cache.root, key) : null;
      if (!hit) {
        pending.push(g);
        continue;
      }
      const cachedLog = join(runDir, 'logs', `${c.id}-${g.id}-${key.slice(0, 12)}.log`);
      copyFileSync(join(cache.root, key, 'log'), cachedLog);
      results.push({
        component: c.id,
        repository: c.repository,
        commit: c.commit,
        gate: g.id,
        command: g.run.join(' '),
        cwd: g.cwd,
        outcome: 'passed',
        exitCode: 0,
        durationMs: 0,
        log: cachedLog,
        summary: hit.summary,
        reused: { key, finishedAt: hit.finishedAt, durationMs: hit.durationMs },
      });
      log(
        `gate ${c.id}:${g.id} reused verified success of ${hit.finishedAt} (original ${Math.round(hit.durationMs / 1000)} s)`,
      );
    }
    if (!pending.length) return;
    try {
      await cleanClone(sourceOf(c), c.commit, dir);
    } catch (err) {
      for (const g of pending)
        results.push({
          component: c.id,
          repository: c.repository,
          commit: c.commit,
          gate: g.id,
          command: g.run.join(' '),
          cwd: g.cwd,
          outcome: 'not-run',
          exitCode: null,
          durationMs: 0,
          log: logFile,
          summary: `clone failed: ${String(err).slice(0, 200)}`,
        });
      return;
    }
    // The component's own root in the clone: its folder, for one that is a folder of its repository.
    const root = rootIn(dir, c);
    // The same install the build uses (frozen lockfile) before TS gates.
    if (existsSync(join(root, 'pnpm-lock.yaml'))) {
      const inst = await run('pnpm', ['install', '--frozen-lockfile'], {
        cwd: root,
        logFile,
        timeoutMs: 1_800_000,
        env: { CI: '1' },
      });
      if (inst.code !== 0) {
        for (const g of pending)
          results.push({
            component: c.id,
            repository: c.repository,
            commit: c.commit,
            gate: g.id,
            command: g.run.join(' '),
            cwd: g.cwd,
            outcome: 'not-run',
            exitCode: null,
            durationMs: 0,
            log: logFile,
            summary: 'pnpm install --frozen-lockfile failed',
          });
        return;
      }
    }
    for (const g of pending) {
      const [cmd, ...args] = g.run as [string, ...string[]];
      let env: Record<string, string> = { CI: '1', ...g.env };
      if (g.needsPostgres) {
        await ensureDatabase('whombat');
        env = {
          ...env,
          // Throwaway databases are created by each suite on the harness's own Postgres (never the shared one).
          DATABASE_URL: pgUrl('whombat'),
          TEST_DATABASE_URL: pgUrl('postgres'),
          WB_MGD_PG_URL: pgUrl('postgres'),
        };
      }
      if (existsSync(restServer)) env.WB_REST_SERVER = restServer;
      log(`gate ${c.id}:${g.id} … ${g.run.join(' ')}`);
      const r = await run(cmd, args, { cwd: join(root, g.cwd), env, logFile, timeoutMs: g.timeoutS * 1000 });
      const res: GateResult = {
        component: c.id,
        repository: c.repository,
        commit: c.commit,
        gate: g.id,
        command: r.command,
        cwd: g.cwd,
        outcome: r.timedOut ? 'timeout' : r.code === 0 ? 'passed' : 'failed',
        exitCode: r.code,
        durationMs: r.durationMs,
        log: logFile,
        summary: summarize(`${r.stdout}\n${r.stderr}`),
      };
      results.push(res);
      if (cache.enabled || res.outcome !== 'passed')
        saveGateCache(cache.root, gateKey(c, g, cache.setup), res);
      log(`gate ${c.id}:${g.id} ${res.outcome} in ${Math.round(r.durationMs / 1000)} s — ${res.summary}`);
    }
  };
  const workers = Array.from({ length: Math.max(1, jobs) }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try {
        await one(c);
      } finally {
        completed.get(c.id)?.resolve();
      }
    }
  });
  await Promise.all(workers);
  return results;
}

interface VitestJson {
  testResults: {
    name: string;
    assertionResults: {
      fullName: string;
      title: string;
      status: string;
      duration?: number;
      failureMessages?: string[];
    }[];
  }[];
}

async function runScenarios(
  runDir: string,
  pattern: string | null,
  log: (l: string) => void,
  exclude: string[] = [],
) {
  const recordFile = join(runDir, 'scenario-records.jsonl');
  const jsonFile = join(runDir, 'scenarios.vitest.json');
  writeFileSync(recordFile, '');
  const args = [
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.scenarios.config.ts',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${jsonFile}`,
  ];
  if (pattern) args.push(pattern);
  log('scenarios … vitest (scenarios/*.scenario.ts)');
  const r = await run('pnpm', args, {
    cwd: HARNESS_DIR,
    env: { WB_SCENARIO_RECORD: recordFile, WB_SCENARIO_EXCLUDE: exclude.join(',') },
    logFile: join(runDir, 'logs', 'scenarios.log'),
    timeoutMs: 3_600_000,
  });
  const records = readFileSync(recordFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const blocked = new Map(
    records.filter((x) => x.kind === 'blocked').map((x) => [String(x.test), String(x.gap)]),
  );
  const scenarios: ScenarioResult[] = [];
  if (existsSync(jsonFile)) {
    const j = JSON.parse(readFileSync(jsonFile, 'utf8')) as VitestJson;
    for (const f of j.testResults)
      for (const a of f.assertionResults) {
        const name = a.fullName;
        const gap = blocked.get(name);
        scenarios.push({
          file: relative(HARNESS_DIR, f.name),
          name,
          outcome: gap
            ? 'blocked'
            : a.status === 'passed'
              ? 'passed'
              : a.status === 'failed'
                ? 'failed'
                : 'skipped',
          durationMs: Math.round(a.duration ?? 0),
          ...(gap ? { blocked: gap } : {}),
          ...(a.failureMessages?.length
            ? { error: a.failureMessages[0]?.split('\n')[0]?.slice(0, 400) }
            : {}),
        });
      }
  } else
    scenarios.push({
      file: '-',
      name: 'vitest did not produce a report',
      outcome: 'failed',
      durationMs: r.durationMs,
      error: `${r.stdout}\n${r.stderr}`.slice(-400),
    });
  if (!scenarios.length || ((r.code !== 0 || r.timedOut) && scenarios.every((s) => s.outcome === 'passed')))
    scenarios.push({
      file: '-',
      name: 'scenario process did not complete successfully',
      outcome: 'failed',
      durationMs: r.durationMs,
      error: `exit ${r.code}, timeout ${r.timedOut}; see logs/scenarios.log`,
    });
  log(`scenarios: ${summarize(`${r.stdout}\n${r.stderr}`)}`);
  return { scenarios, records };
}

export async function runScenarioShard(
  file: string,
  slot: number,
  runDir: string,
  log: (l: string) => void,
): Promise<{
  scenarios: ScenarioResult[];
  records: Record<string, unknown>[];
}> {
  const env: Record<string, string> = {
    ...scenarioEnv({ home: STATE_HOME, container: PG_CONTAINER, ports }, slot),
    WB_MGD_PINS: PINS_FILE,
  };
  const logFile = join(runDir, 'logs', `isolated-${file}.log`);
  let result: { scenarios: ScenarioResult[]; records: Record<string, unknown>[] } = {
    scenarios: [],
    records: [],
  };
  const cleanupFailed = (error: string) =>
    result.scenarios.push({
      file: `scenarios/${file}`,
      name: `cleanup ${file}`,
      outcome: 'failed',
      durationMs: 0,
      error,
    });
  log(`isolated ${file}: private environment ${env.WB_MGD_HOME}`);
  const purge = () =>
    run(process.execPath, [join(HARNESS_DIR, 'src/dev/down.ts'), '--purge'], {
      cwd: HARNESS_DIR,
      env,
      logFile,
      timeoutMs: 300_000,
    });
  try {
    // The private environment is this validation's alone (the environment lock): one a killed run left running holds
    // the ports checked next, so it goes first.
    const leftover = await purge();
    if (leftover.code !== 0)
      throw new Error(`clearing the private environment exited ${leftover.code}; see ${logFile}`);
    const busy = await busyPorts(env);
    if (busy.length)
      throw new Error(
        `isolated suite's ports are in use (${busy.join(', ')}): move the environment's base ports (IN-131)`,
      );
    const r = await run(
      process.execPath,
      [
        join(HARNESS_DIR, 'src/validate/validate.ts'),
        '--skip-gates',
        '--no-build',
        '--scenario-jobs',
        '1',
        '--scenarios',
        file,
      ],
      {
        cwd: HARNESS_DIR,
        env,
        logFile,
        timeoutMs: 3_600_000,
      },
    );
    const reportFile = /report: (\S+report\.md)/
      .exec(`${r.stderr}\n${r.stdout}`)?.[1]
      ?.replace(/\.md$/, '.json');
    if (!reportFile) throw new Error(`isolated suite produced no report (exit ${r.code})`);
    const report = ShardReport.parse(JSON.parse(readFileSync(reportFile, 'utf8')));
    if (report.manifest.pinsFile !== PINS_FILE || !report.manifest.ok || report.harness?.outcome !== 'passed')
      throw new Error('isolated suite did not validate the candidate and harness');
    const expectedPins = loadPins()
      .components.map((c) => `${c.id}:${c.commit}`)
      .sort();
    if (
      report.pins
        .map((c) => `${c.id}:${c.commit}`)
        .sort()
        .join() !== expectedPins.join()
    )
      throw new Error('isolated suite ran different pinned commits');
    const before = report.scenarios.find((s) => s.outcome === 'failed' && s.file !== `scenarios/${file}`);
    if (before)
      throw new Error(`isolated suite failed before its scenarios: ${before.name}: ${before.error ?? ''}`);
    if (!report.scenarios.length || report.scenarios.some((s) => s.file !== `scenarios/${file}`))
      throw new Error('isolated suite ran a different scenario selection');
    if (r.code !== 0 && report.scenarios.every((s) => s.outcome === 'passed'))
      throw new Error(`isolated suite exited ${r.code} despite passing scenario records`);
    log(
      `isolated ${file}: ${report.scenarios.filter((s) => s.outcome === 'passed').length}/${report.scenarios.length} passed; report ${reportFile}`,
    );
    result = {
      scenarios: report.scenarios,
      records: [
        ...report.records,
        ...report.measurements,
        ...report.gaps,
        {
          kind: 'note',
          test: file,
          detail: 'isolated scenario environment',
          home: env.WB_MGD_HOME,
          report: reportFile,
          log: logFile,
        },
      ],
    };
  } catch (err) {
    result = {
      scenarios: [
        {
          file: `scenarios/${file}`,
          name: `isolated ${file}`,
          outcome: 'failed',
          durationMs: 0,
          error: String(err),
        },
      ],
      records: [],
    };
  } finally {
    try {
      const down = await purge();
      if (down.code !== 0) cleanupFailed(`cleanup exited ${down.code}; see ${logFile}`);
    } catch (err) {
      cleanupFailed(String(err));
    }
  }
  return result;
}

export async function validate(options: {
  skipGates: boolean;
  gates: string[] | null;
  skipScenarios: boolean;
  scenarios: string | null;
  jobs: number;
  live: LiveSelection | null;
  buildManifest: boolean;
  /** Soak duration in ms (0: none). */
  soakMs: number;
  /** Run the scenarios in the running environment instead of a fresh one. */
  reuseEnv: boolean;
  /** Independent update/licence environments (1 keeps the original sequential suite). */
  scenarioJobs?: number;
  gateCache?: boolean;
}): Promise<ValidationReport> {
  acquireEnvLock('harness/validate');
  const started = new Date();
  const runDir = newRunDir(started);
  const runId = basename(runDir);
  mkdirSync(join(runDir, 'logs'), { recursive: true });
  const log = (l: string) =>
    process.stderr.write(
      `[validate ${((Date.now() - started.getTime()) / 1000).toFixed(0).padStart(4)}s] ${l}\n`,
    );
  const pins = loadPins();
  if (
    !Number.isInteger(options.scenarioJobs ?? 3) ||
    (options.scenarioJobs ?? 3) < 1 ||
    (options.scenarioJobs ?? 3) > 3
  )
    throw new Error('--scenario-jobs must be 1, 2 or 3');
  const version = async (c: string, a: string[]) =>
    (await run(c, a, { cwd: HARNESS_DIR })).stdout.trim().split('\n')[0] ?? '';
  const host = {
    node: process.version,
    pnpm: await version('pnpm', ['--version']),
    go: await version('go', ['version']),
    docker: await version('docker', ['--version']),
    kernel: await version('uname', ['-sr']),
  };
  let manifest = validateManifest();
  if (!manifest.ok && options.buildManifest) {
    log('manifest: stale or invalid; rebuilding from the pins in clean clones (manifest/build)');
    await buildAll({});
    manifest = validateManifest();
  }
  log(`manifest: ${manifest.ok ? 'valid' : `INVALID (${manifest.problems.join('; ')})`}`);

  await ensurePostgres(log);
  const pgImage = (
    await run('docker', ['image', 'inspect', '--format', '{{.Id}}', 'postgres:17'], { cwd: HARNESS_DIR })
  ).stdout.trim();
  const setup = {
    ...host,
    postgres: pgImage,
    runner: gateRunnerFingerprint(),
    restServer: existsSync(join(paths.bin, `rest-server-${REST_SERVER_VERSION}`, 'rest-server'))
      ? REST_SERVER_VERSION
      : 'absent',
    environment: createHash('sha256')
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(process.env)
              .filter(([key]) =>
                /^(GO|NIX|WB_|VITEST|PLAYWRIGHT|WHOMBAT_|NODE_|DATABASE_URL$|TEST_DATABASE_URL$)/.test(key),
              )
              .sort(),
          ),
        ),
      )
      .digest('hex'),
  };
  if (!options.skipGates) {
    const restServer = join(paths.bin, `rest-server-${REST_SERVER_VERSION}`, 'rest-server');
    const tools = [
      'git',
      'bash',
      'node',
      'pnpm',
      'go',
      'make',
      'restic',
      'rest-server',
      'minio',
      'ssh-keygen',
      'sshd',
      'nft',
      'unshare',
      ...(existsSync(restServer) ? [restServer] : []),
      ...['WB_REST_SERVER', 'WB_MINIO', 'WB_SSHD'].flatMap((name) =>
        process.env[name] ? [process.env[name] as string] : [],
      ),
      ...['pg_dump', 'pg_restore', 'initdb', 'pg_ctl'].map((name) =>
        join(process.env.WB_PG_BIN ?? '/usr/lib/postgresql/17/bin', name),
      ),
    ];
    const binaries = await Promise.all(
      tools.map(async (tool) => {
        const resolved = (
          await run('bash', ['-c', 'command -v -- "$1"', 'gate-tool', tool], { cwd: HARNESS_DIR })
        ).stdout.trim();
        return [
          tool,
          resolved && existsSync(resolved) ? `${resolved}:${await sha256File(resolved)}` : 'absent',
        ];
      }),
    );
    Object.assign(setup, { binaries: createHash('sha256').update(JSON.stringify(binaries)).digest('hex') });
  }
  const gates = options.skipGates
    ? []
    : await runGates(pins.components, runDir, options.gates, options.jobs, log, {
        root: join(STATE_HOME, 'gate-cache'),
        enabled: options.gateCache !== false,
        setup,
      });
  if (!options.skipGates && options.gateCache !== false) pruneGateCache(join(STATE_HOME, 'gate-cache'));

  log('harness: pnpm check');
  const h = await run('pnpm', ['check'], {
    cwd: HARNESS_DIR,
    logFile: join(runDir, 'logs', 'harness.log'),
    timeoutMs: 600_000,
  });
  const harness: GateResult = {
    component: 'integration-harness',
    repository: 'whombat-appliance',
    commit: (await run('git', ['rev-parse', 'HEAD'], { cwd: HARNESS_DIR })).stdout.trim(),
    gate: 'check',
    command: 'pnpm check',
    cwd: 'harness',
    outcome: h.code === 0 ? 'passed' : 'failed',
    exitCode: h.code,
    durationMs: h.durationMs,
    log: join(runDir, 'logs', 'harness.log'),
    summary: summarize(`${h.stdout}\n${h.stderr}`),
  };

  // LC-17: the hosted app's public terms equal the appliance's draft byte for byte (contracts ≥ 0.10.0).
  const terms = options.skipGates ? null : termsGate(pins);
  if (terms) {
    gates.push({
      component: 'integration-harness',
      repository: `${terms.app.repository} + ${terms.appliance.repository}`,
      commit: `${terms.app.commit.slice(0, 12)} + ${terms.appliance.commit.slice(0, 12)}`,
      gate: 'appliance-terms',
      command: `git show <app>:${APP_TERMS} == git show <appliance>:docs/legal/appliance-terms.md`,
      cwd: '.',
      outcome: terms.ok ? 'passed' : 'failed',
      exitCode: terms.ok ? 0 : 1,
      durationMs: 0,
      log: '',
      summary: terms.summary,
    });
    log(`gate appliance-terms (LC-17) ${terms.ok ? 'passed' : 'FAILED'} — ${terms.summary}`);
  }

  let scenarios: ScenarioResult[] = [];
  let records: Record<string, unknown>[] = [];
  if (!options.skipScenarios) {
    const isolated = isolatedScenarioFiles({
      scenarioJobs: options.scenarioJobs ?? 3,
      scenarios: options.scenarios,
      reuseEnv: options.reuseEnv,
      live: !!options.live,
      public: !!publicUrls,
      agents: agentsMode,
    });
    // Start private appliances before preparing the baseline appliance. No scenario shares writable state.
    const envFailures: string[] = [];
    const shards = isolated.map((file, index) => runScenarioShard(file, index + 1, runDir, log));
    try {
      // Scenarios start from a fresh environment (a new, unclaimed appliance) unless --reuse-env.
      if (options.reuseEnv) {
        const env = loadEnv();
        if (env?.pinsFile && env.pinsFile !== PINS_FILE)
          throw new Error(
            `the environment runs ${env.pinsFile} but this validation uses ${PINS_FILE}; set WB_MGD_PINS or dev/down`,
          );
        if (env?.services.runtime?.status !== 'running') {
          const r = await up({
            live: options.live,
            lockfileDrift: false,
            without: new Set(),
            reset: false,
            quiet: false,
          });
          if (r.failures.length) log(`dev/up: ${r.failures.join('; ')}`);
        }
      } else {
        log('fresh environment for the scenarios (dev/down --purge, dev/up)');
        await stopAll({ purge: true, quiet: true });
        // Stopped, nothing of this environment listens: a port still held is another service's (the dev stack without
        // its own WB_MGD_DIRECT_PORT took 4621 once), and the scenarios would talk to it instead.
        const held = await busyPorts(
          Object.fromEntries(
            Object.entries(PORT_VARIABLES).map(([key, name]) => [
              name,
              String(ports[key as keyof typeof ports]),
            ]),
          ),
        );
        if (held.length)
          throw new Error(
            `the scenario environment's ports are in use by something else (${held.join(', ')})`,
          );
        // The real manager or none: a stand-in in its place only skips the update and licence cases.
        const r = await up({
          live: options.live,
          lockfileDrift: false,
          without: new Set(),
          reset: false,
          quiet: true,
          manager: 'real',
        });
        if (r.failures.length) {
          log(`dev/up: ${r.failures.join('; ')}`);
          envFailures.push(...r.failures);
        }
      }
      const baseline = await runScenarios(runDir, options.scenarios, log, isolated);
      scenarios = [
        ...envFailures.map((error) => ({
          file: '-',
          name: 'scenario environment: a service did not start',
          outcome: 'failed' as const,
          durationMs: 0,
          error,
        })),
        ...baseline.scenarios,
      ];
      records = baseline.records;
    } catch (err) {
      scenarios.push({
        file: '-',
        name: 'baseline scenario environment',
        outcome: 'failed',
        durationMs: 0,
        error: String(err),
      });
    } finally {
      for (const shard of await Promise.all(shards)) {
        scenarios.push(...shard.scenarios);
        records.push(...shard.records);
      }
    }
  }
  let soakResult: Record<string, unknown> | null = null;
  if (options.soakMs > 0) {
    // The soak measures the pinned product, not what slice C left behind (fixture builds, a contracted schema):
    // a fresh environment unless --reuse-env (IN-27).
    if (!options.reuseEnv) {
      log('fresh environment for the soak (dev/down --purge, dev/up)');
      await stopAll({ purge: true, quiet: true });
      const r = await up({
        live: options.live,
        lockfileDrift: false,
        without: new Set(),
        reset: false,
        quiet: true,
      });
      if (r.failures.length) log(`dev/up: ${r.failures.join('; ')}`);
    }
    log(`soak: ${Math.round(options.soakMs / 60_000)} min of steady traffic with RSS sampling`);
    const r = await run('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.soak.config.ts'], {
      cwd: HARNESS_DIR,
      env: { WB_SOAK_MS: String(options.soakMs), WB_SOAK_OUT: runDir },
      logFile: join(runDir, 'logs', 'soak.log'),
      timeoutMs: options.soakMs + 1_800_000,
    });
    try {
      soakResult = JSON.parse(readFileSync(join(runDir, 'soak.json'), 'utf8'));
    } catch {
      soakResult = { ok: false, reasons: [`soak did not finish (exit ${r.code}); see logs/soak.log`] };
    }
    log(
      `soak: ${(soakResult as { ok?: boolean }).ok ? 'ok' : `FAILED ${JSON.stringify((soakResult as { reasons?: unknown }).reasons)}`}`,
    );
  }
  const env = loadEnv();
  const totals: Record<string, number> = {};
  for (const g of [...gates, harness]) totals[`gates.${g.outcome}`] = (totals[`gates.${g.outcome}`] ?? 0) + 1;
  for (const s of scenarios) totals[`scenarios.${s.outcome}`] = (totals[`scenarios.${s.outcome}`] ?? 0) + 1;
  const report: ValidationReport = {
    $schema: 'whombat.validation-report/1',
    runId,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    host,
    manifest: { ...manifest, productVersion: pins.productVersion, pinsFile: PINS_FILE },
    pins: pins.components.map((c) => ({ id: c.id, repository: c.repository, ref: c.ref, commit: c.commit })),
    environment: env
      ? {
          mode: env.mode,
          sources: Object.fromEntries(
            Object.values(env.sources).map((s) => [
              s.id,
              `${s.commit}${s.dirty ? ' (dirty)' : ''}${s.lockfileDrift ? ' (lockfile drift)' : ''}`,
            ]),
          ),
        }
      : null,
    gates,
    harness,
    scenarios,
    records: records.filter((x) => x.kind === 'note' || x.kind === 'blocked'),
    measurements: records.filter((x) => x.kind === 'measure'),
    gaps: records.filter((x) => x.kind === 'gap'),
    soak: soakResult,
    totals,
    ok:
      manifest.ok &&
      harness.outcome === 'passed' &&
      gates.every((g) => g.outcome === 'passed') &&
      scenarios.every((s) => s.outcome === 'passed') &&
      (soakResult === null || (soakResult as { ok?: boolean }).ok === true),
  };
  writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(runDir, 'report.md'), renderMarkdown(report));
  const full = !options.skipGates && !options.gates && !options.skipScenarios && !options.scenarios;
  const latest = MANIFEST_FILES.candidate ? `latest-${basename(PINS_FILE, '.json')}` : 'latest';
  if (full) {
    copyFileSync(join(runDir, 'report.json'), join(REPORTS_DIR, `${latest}.json`));
    copyFileSync(join(runDir, 'report.md'), join(REPORTS_DIR, `${latest}.md`));
  }
  log(
    `report: ${join(runDir, 'report.md')}${full ? ` (also reports/${latest}.md)` : ' (partial run: the latest report is not replaced)'}`,
  );
  return report;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const val = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? (args[i + 1] ?? null) : null;
  };
  const report = await validate({
    skipGates: args.includes('--skip-gates'),
    gates: val('--gates')?.split(',').filter(Boolean) ?? null,
    skipScenarios: args.includes('--skip-scenarios'),
    scenarios: val('--scenarios'),
    jobs: Number(val('--jobs') ?? 2),
    live: liveArg(args),
    buildManifest: !args.includes('--no-build'),
    soakMs: val('--soak') ? parseDuration(val('--soak') as string) : 0,
    reuseEnv: args.includes('--reuse-env'),
    scenarioJobs: Number(val('--scenario-jobs') ?? 3),
    gateCache: !args.includes('--no-gate-cache'),
  });
  process.stdout.write(renderMarkdown(report).split('\n## Scenarios')[0] ?? '');
  process.exit(report.ok ? 0 : 1);
}

/**
 * The run's report directory, `reports/<YYYY-MM-DD-HHMM>` — or `-2`, `-3`, … when another run started in the same
 * minute (release/ship validate starts the scripted and the live environment's runs together, IN-116). Created here, so
 * two runs never share one.
 */
export function newRunDir(started: Date, root = REPORTS_DIR): string {
  const base = started.toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  mkdirSync(root, { recursive: true });
  for (let n = 1; ; n++) {
    const dir = join(root, n === 1 ? base : `${base}-${n}`);
    try {
      mkdirSync(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}
