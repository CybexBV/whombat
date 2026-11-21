/**
 * `manifest/build`: checks out every pinned component into a fresh scratch area (clean `git clone --no-local`
 * at the exact commit, IN-05), runs its build from the frozen lockfile / go.sum, digests the artifacts and writes
 * `manifest/build-report.json` and the strict `manifest/product-manifest.json` (IN-02, IN-06).
 *
 *   manifest/build [--only id,id] [--keep] [--no-manifest]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { archive, cleanClone } from '../lib/git.ts';
import { deterministicTarball, parseSha256Sums, sha256File } from '../lib/hash.ts';
import { expandHome, paths } from '../lib/paths.ts';
import { run } from '../lib/proc.ts';
import { type Component, loadPins, MANIFEST_FILES, type Pins, rootIn, sourceOf, treeIn } from './pins.ts';
import { writeProductManifest } from './product.ts';

export interface ArtifactResult {
  component: string;
  name: string;
  kind: string;
  sha256: string | null;
  file: string | null;
  ok: boolean;
  detail?: string;
  /** For `sums` artifacts: per-file digests and the comparison with the published sums. */
  files?: { file: string; sha256: string; published: string | null; matches: boolean | null }[];
}

export interface StepResult {
  command: string;
  cwd: string;
  code: number | null;
  durationMs: number;
  timedOut: boolean;
}

export interface ComponentBuild {
  id: string;
  repository: string;
  ref: string;
  commit: string;
  checkout: string;
  cleanClone: boolean;
  contracts: { vendored: string[]; goModule: string | null; sumsMatchRelease: boolean | null };
  steps: StepResult[];
  artifacts: ArtifactResult[];
  ok: boolean;
  log: string;
  error?: string;
}

export interface BuildReport {
  $schema: 'whombat.integration-build/1';
  runId: string;
  startedAt: string;
  finishedAt: string;
  host: { node: string; go: string; pnpm: string };
  scratch: string;
  components: ComponentBuild[];
  ok: boolean;
}

export const BUILD_REPORT_FILE = MANIFEST_FILES.buildReport;

async function version(cmd: string, args: string[]): Promise<string> {
  const r = await run(cmd, args, { cwd: process.cwd() });
  return (r.stdout || r.stderr).trim().split('\n')[0] ?? 'unknown';
}

/** Which contracts release a checkout vendors (TS tarballs and/or the Go module). */
export function detectContracts(
  dir: string,
  contractsSums: Map<string, string>,
): ComponentBuild['contracts'] {
  const vendored: string[] = [];
  let sumsMatch: boolean | null = null;
  for (const base of ['vendor/whombat-contracts', 'harness/vendor/whombat-contracts']) {
    const d = join(dir, base);
    if (!existsSync(d)) continue;
    for (const v of readdirSync(d)) {
      vendored.push(v);
      const sums = parseSha256Sums(join(d, v, 'SHA256SUMS'));
      if (contractsSums.size && sums.size) {
        const same = [...sums].every(([f, h]) => !contractsSums.has(f) || contractsSums.get(f) === h);
        sumsMatch = (sumsMatch ?? true) && same;
      }
    }
  }
  // Go consumers vendor the module under <module>/third_party/ with a VERSION or VENDORED.md naming the tarball.
  let goModule: string | null = null;
  for (const base of ['', 'backup/', 'provisioning/', 'manager/']) {
    for (const f of [
      'whombat-contracts-go/VERSION',
      'whombat-contracts-go/VENDORED.md',
      'VENDORED.md',
      'README.md',
    ]) {
      const p = join(dir, base, 'third_party', f);
      if (goModule || !existsSync(p)) continue;
      const text = readFileSync(p, 'utf8');
      const m = f.endsWith('VERSION')
        ? /^(\d+\.\d+\.\d+)/.exec(text.trim())
        : /whombat-contracts-go-(\d+\.\d+\.\d+)\.tar\.gz/.exec(text);
      if (m?.[1]) goModule = m[1];
    }
  }
  return { vendored: vendored.sort(), goModule, sumsMatchRelease: sumsMatch };
}

async function buildOne(
  c: Component,
  scratch: string,
  contractsSums: Map<string, string>,
): Promise<ComponentBuild> {
  const dir = join(scratch, c.id);
  const log = join(scratch, `${c.id}.log`);
  const out: ComponentBuild = {
    id: c.id,
    repository: c.repository,
    ref: c.ref,
    commit: c.commit,
    checkout: dir,
    cleanClone: false,
    contracts: { vendored: [], goModule: null, sumsMatchRelease: null },
    steps: [],
    artifacts: [],
    ok: false,
    log,
  };
  try {
    await cleanClone(sourceOf(c), c.commit, dir);
    out.cleanClone = true;
    // The component's own root in the clone: its folder, for one that is a folder of its repository.
    const root = rootIn(dir, c);
    const tree = treeIn(dir, c);
    out.contracts = detectContracts(root, contractsSums);
    for (const step of c.build) {
      const [cmd, ...args] = step.run as [string, ...string[]];
      const r = await run(cmd, args, {
        cwd: join(root, step.cwd),
        env: { CI: '1', ...step.env },
        logFile: log,
        timeoutMs: step.timeoutS * 1000,
      });
      out.steps.push({
        command: r.command,
        cwd: relative(scratch, r.cwd) || '.',
        code: r.code,
        durationMs: r.durationMs,
        timedOut: r.timedOut,
      });
      if (r.code !== 0)
        throw new Error(`build step failed: ${r.command} (exit ${r.code ?? r.signal}); see ${log}`);
    }
    const artifactsDir = join(scratch, '_artifacts', c.id);
    mkdirSync(artifactsDir, { recursive: true });
    for (const a of c.artifacts) out.artifacts.push(...(await digest(c, a, root, artifactsDir, tree)));
    out.ok = out.artifacts.every((a) => a.ok);
    if (!out.ok)
      out.error = out.artifacts
        .filter((a) => !a.ok)
        .map((a) => `${a.name}: ${a.detail}`)
        .join('; ');
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}

async function digest(
  c: Component,
  a: Component['artifacts'][number],
  dir: string,
  artifactsDir: string,
  /** What `git-archive` packs: the pinned commit, or the component's folder of it. */
  tree: string = c.commit,
): Promise<ArtifactResult[]> {
  const base = { component: c.id, name: a.name, kind: a.kind };
  const safe = a.name.replace(/[^A-Za-z0-9._-]/g, '_');
  switch (a.from.type) {
    case 'file': {
      const f = join(dir, a.from.path);
      if (!existsSync(f))
        return [{ ...base, sha256: null, file: null, ok: false, detail: `missing ${a.from.path}` }];
      return [{ ...base, sha256: await sha256File(f), file: relative(dir, f), ok: true }];
    }
    case 'tar': {
      const cwd = join(dir, a.from.cwd);
      const missing = a.from.paths.filter((p) => !existsSync(join(cwd, p)));
      if (missing.length)
        return [{ ...base, sha256: null, file: null, ok: false, detail: `missing ${missing.join(', ')}` }];
      const outFile = join(artifactsDir, `${safe}.tar.gz`);
      return [
        { ...base, sha256: await deterministicTarball(cwd, a.from.paths, outFile), file: outFile, ok: true },
      ];
    }
    case 'git-archive': {
      const outFile = join(artifactsDir, `${safe}.tar.gz`);
      await archive(dir, tree, outFile, a.from.prefix);
      return [{ ...base, sha256: await sha256File(outFile), file: outFile, ok: true }];
    }
    case 'sums': {
      const sumsFile = join(dir, a.from.path);
      if (!existsSync(sumsFile))
        return [{ ...base, sha256: null, file: null, ok: false, detail: `missing ${a.from.path}` }];
      const listed = parseSha256Sums(sumsFile);
      const published = a.from.compareWith
        ? parseSha256Sums(expandHome(a.from.compareWith))
        : new Map<string, string>();
      const files: NonNullable<ArtifactResult['files']> = [];
      for (const [name, listedHash] of listed) {
        const actual = await sha256File(join(sumsFile, '..', name));
        const pub = published.get(name) ?? null;
        files.push({
          file: name,
          sha256: actual,
          published: pub,
          matches: actual !== listedHash ? false : pub === null ? null : pub === actual,
        });
      }
      const mismatched = files.filter((f) => f.matches === false).map((f) => f.file);
      return [
        {
          ...base,
          sha256: await sha256File(sumsFile),
          file: relative(dir, sumsFile),
          ok: true,
          detail: mismatched.length
            ? `rebuilt tarballs differ from the published release: ${mismatched.join(', ')} (not reproducible; the published sums stay pinned)`
            : 'rebuilt tarballs match the published release byte for byte',
          files,
        },
      ];
    }
  }
}

export async function buildAll(options: {
  only?: string[];
  keep?: boolean;
  writeManifest?: boolean;
}): Promise<BuildReport> {
  const pins: Pins = loadPins();
  const runId = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const scratch = join(paths.scratch, runId);
  mkdirSync(scratch, { recursive: true });
  const started = new Date().toISOString();
  const contractsComponent = pins.components.find((c) => c.id === pins.contracts.component);
  const published = contractsComponent
    ? parseSha256Sums(
        join(sourceOf(contractsComponent), 'dist-release', pins.contracts.version, 'SHA256SUMS'),
      )
    : new Map<string, string>();
  const selected = pins.components.filter((c) => !options.only || options.only.includes(c.id));
  const components: ComponentBuild[] = [];
  for (const c of selected) {
    process.stderr.write(`▸ ${c.id} @ ${c.commit.slice(0, 12)} (${c.ref}) … `);
    const t = Date.now();
    const r = await buildOne(c, scratch, published);
    components.push(r);
    process.stderr.write(`${r.ok ? 'ok' : 'FAILED'} in ${Math.round((Date.now() - t) / 1000)} s\n`);
    if (!r.ok) process.stderr.write(`  ${r.error}\n`);
  }
  const report: BuildReport = {
    $schema: 'whombat.integration-build/1',
    runId,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    host: {
      node: process.version,
      go: await version('go', ['version']),
      pnpm: await version('pnpm', ['--version']),
    },
    scratch,
    components,
    ok: components.every((c) => c.ok),
  };
  // Merge with the previous report when only some components were rebuilt.
  let merged = report;
  if (options.only && existsSync(BUILD_REPORT_FILE)) {
    const prev = JSON.parse(readFileSync(BUILD_REPORT_FILE, 'utf8')) as BuildReport;
    const keep = prev.components.filter(
      (p) =>
        !components.some((c) => c.id === p.id) &&
        pins.components.some((x) => x.id === p.id && x.commit === p.commit),
    );
    merged = {
      ...report,
      components: [...keep, ...components].sort((a, b) => order(pins, a.id) - order(pins, b.id)),
    };
    merged.ok = merged.components.every((c) => c.ok);
  }
  writeFileSync(BUILD_REPORT_FILE, `${JSON.stringify(merged, null, 2)}\n`);
  writeFileSync(join(scratch, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (options.writeManifest !== false) await writeProductManifest(pins, merged);
  if (!options.keep && report.ok) {
    // Remove only the scratch directory this run created.
    rmSync(scratch, { recursive: true, force: true });
  }
  return merged;
}

const order = (pins: Pins, id: string) => pins.components.findIndex((c) => c.id === id);

if (import.meta.main) {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? '').split(',').filter(Boolean) : undefined;
  const report = await buildAll({
    only,
    keep: args.includes('--keep'),
    writeManifest: !args.includes('--no-manifest'),
  });
  process.stderr.write(`\nbuild report: ${BUILD_REPORT_FILE}\n`);
  if (!args.includes('--keep') && report.ok) process.stderr.write(`scratch removed: ${report.scratch}\n`);
  else process.stderr.write(`scratch kept: ${report.scratch}\n`);
  process.exit(report.ok ? 0 : 1);
}
