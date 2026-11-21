/**
 * Component sources for the local environment (IN-07). Pinned (default): clean clones at the manifest's commits
 * under `~/.cache/whombat-mgd/src/`, installed with `--frozen-lockfile`. Live (`--live`): the other agents' working
 * trees as they are — the harness never installs into or builds inside them (Go binaries go to its own bin/).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ensureClone, headOf, isClean } from '../lib/git.ts';
import { sha256Text } from '../lib/hash.ts';
import { expandHome, paths } from '../lib/paths.ts';
import { must, run } from '../lib/proc.ts';
import { type Component, loadPins, rootIn } from '../manifest/pins.ts';
import type { SourceState } from './env.ts';
import { touchCopy } from './prune-copies.ts';

/** Short names for `--live`: app, runtime, api (or control), relay, manager (or the pins' ids). */
export const LIVE_ALIASES: Record<string, string> = {
  app: 'whombat-app',
  runtime: 'whombat-runtime',
  api: 'whombat-api',
  control: 'whombat-api',
  relay: 'whombat-relay',
  manager: 'appliance-manager',
  hosts: 'whombat-hosts',
};

/** `all`, or the component ids (aliases resolved) that run from their live working trees. */
export type LiveSelection = 'all' | string[];

export function parseLive(value: string | undefined | null): LiveSelection {
  if (!value || value === '1' || value === 'all') return 'all';
  return value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => LIVE_ALIASES[x] ?? x);
}

export function isLive(sel: LiveSelection, id: string): boolean {
  return sel === 'all' || sel.includes(id);
}

export interface PrepareOptions {
  /** Whether this component runs from its live working tree. */
  live: boolean;
  /** Pinned mode only: install without --frozen-lockfile when the committed lockfile is stale (recorded). */
  lockfileDrift: boolean;
  log: (line: string) => void;
}

/**
 * The component's repository for the run: its live working tree, or a clean clone at the pinned commit. `path` is the
 * clone as a whole; a component that is a folder of its repository gets its own root from {@link sourcePreparation}.
 */
export async function resolveSource(c: Component, options: PrepareOptions): Promise<SourceState> {
  if (options.live) {
    if (!c.live) throw new Error(`${c.id}: no live working tree configured in pins.json`);
    const path = expandHome(c.live);
    if (!existsSync(path)) throw new Error(`${c.id}: live tree ${path} does not exist`);
    return { id: c.id, path, commit: await headOf(path), mode: 'live', dirty: !(await isClean(path)) };
  }
  const path = join(paths.src, `${c.id}@${c.commit.slice(0, 12)}`);
  const how = await ensureClone(expandHome(c.source), c.commit, path);
  touchCopy(path);
  options.log(`${c.id}: ${how} clean clone at ${c.commit.slice(0, 12)}`);
  return { id: c.id, path, commit: c.commit, mode: 'pinned', dirty: false };
}

/** `pnpm install` once per lockfile (pinned clones only; live trees must already be installed). */
export async function pnpmInstall(src: SourceState, options: PrepareOptions): Promise<void> {
  const nm = join(src.path, 'node_modules');
  if (src.mode === 'live') {
    if (!existsSync(nm))
      throw new Error(
        `${src.id}: ${src.path} has no node_modules; install it there yourself (the harness never does in --live)`,
      );
    return;
  }
  const lock = readFileSync(join(src.path, 'pnpm-lock.yaml'), 'utf8');
  // Beside the clone; for a component that is a folder of its clone, inside its node_modules, which the repository
  // ignores: a file beside the folder would make the clone look changed, and it would be cloned again every run.
  const marker = existsSync(join(src.path, '.git'))
    ? `${src.path}.installed`
    : join(nm, '.harness-installed');
  const want = sha256Text(lock);
  if (existsSync(nm) && existsSync(marker) && readFileSync(marker, 'utf8').trim().startsWith(want)) {
    src.lockfileDrift = readFileSync(marker, 'utf8').includes('drift');
    return;
  }
  options.log(`${src.id}: pnpm install --frozen-lockfile`);
  const logFile = join(paths.logs, `install-${src.id}.log`);
  const frozen = await run('pnpm', ['install', '--frozen-lockfile'], {
    cwd: src.path,
    logFile,
    timeoutMs: 1_800_000,
  });
  if (frozen.code === 0) {
    writeFileSync(marker, `${want}\n`);
    return;
  }
  if (!options.lockfileDrift)
    throw new Error(
      `${src.id}: pnpm install --frozen-lockfile failed at ${src.commit.slice(0, 12)} (see ${logFile}).\n` +
        '  The committed lockfile does not install from a clean checkout. Fix it in that repository, or pass\n' +
        '  --lockfile-drift to install without --frozen-lockfile in the harness clone (recorded in env.json).',
    );
  options.log(
    `${src.id}: frozen install failed; --lockfile-drift: pnpm install --no-frozen-lockfile (harness clone only)`,
  );
  await must('pnpm', ['install', '--no-frozen-lockfile'], { cwd: src.path, logFile, timeoutMs: 1_800_000 });
  // Restore the committed lockfile so the clone stays clean; node_modules keeps the drifted install.
  await run('git', ['checkout', '--', '.'], { cwd: src.path });
  writeFileSync(marker, `${want} drift\n`);
  src.lockfileDrift = true;
}

/**
 * One clone and install for components of the same pinned repository and commit (the app and runtime share Whombat).
 * Pending work is shared too, so preparing pages beside service startup cannot race a clone or pnpm install.
 */
export function sourcePreparation(
  pins: ReadonlyMap<string, Component>,
  options: (id: string) => PrepareOptions,
  deps = { resolve: resolveSource, install: pnpmInstall },
): {
  source: (id: string) => Promise<SourceState>;
  install: (src: SourceState) => Promise<void>;
} {
  const sources = new Map<string, Promise<SourceState>>();
  const clones = new Map<string, Promise<SourceState>>();
  const installs = new Map<string, Promise<boolean | undefined>>();
  return {
    async source(id) {
      let source = sources.get(id);
      if (!source) {
        const c = pins.get(id);
        if (!c) throw new Error(`pins.json has no ${id}`);
        const prep = options(id);
        const key = prep.live ? `live:${id}` : JSON.stringify([expandHome(c.source), c.commit]);
        let clone = clones.get(key);
        if (!clone) {
          clone = deps.resolve(c, prep);
          clones.set(key, clone);
        }
        // One clone serves every component of that repository and commit; each has its own root in it (control and
        // the relay are folders of whombat-cloud). A live tree is named as the component's root already.
        source = clone.then((s) => ({ ...s, id, path: prep.live ? s.path : rootIn(s.path, c) }));
        sources.set(id, source);
      }
      return source;
    },
    async install(src) {
      let installed = installs.get(src.path);
      if (!installed) {
        installed = deps.install(src, options(src.id)).then(() => src.lockfileDrift);
        installs.set(src.path, installed);
      }
      src.lockfileDrift = await installed;
    },
  };
}

export interface GoBuildOptions {
  /** `-ldflags` (e.g. `-X main.version=…`). */
  ldflags?: string;
  /** Another architecture (`GOARCH`, Linux): each binary is written as `<name>-linux-<arch>`. */
  goarch?: string;
  /** Where under the harness's bin directory (default `<id>@<commit12>`). */
  dir?: string;
}

/** Go binaries into the harness's own bin directory (never inside a live tree). */
export async function goBuild(
  src: SourceState,
  pkgs: string[],
  moduleDir = '.',
  options: GoBuildOptions = {},
): Promise<string> {
  const out = join(
    paths.bin,
    options.dir ?? `${src.id}@${src.commit.slice(0, 12)}${src.dirty ? '-dirty' : ''}`,
  );
  const stamp = join(out, `.stamp${options.goarch ? `-${options.goarch}` : ''}`);
  const want = pkgs.join(' ');
  if (!src.dirty && existsSync(stamp) && readFileSync(stamp, 'utf8').includes(`pkgs: ${want}\n`)) {
    touchCopy(out);
    return out;
  }
  const flags = ['-trimpath', ...(options.ldflags ? ['-ldflags', options.ldflags] : [])];
  const cwd = join(src.path, moduleDir);
  const build = {
    cwd,
    env: { CGO_ENABLED: '0', ...(options.goarch ? { GOOS: 'linux', GOARCH: options.goarch } : {}) },
    logFile: join(paths.logs, `build-${src.id}.log`),
    timeoutMs: 900_000,
  };
  mkdirSync(out, { recursive: true });
  if (!options.goarch) await must('go', ['build', ...flags, '-o', `${out}/`, ...pkgs], build);
  else
    for (const pkg of pkgs)
      await must(
        'go',
        ['build', ...flags, '-o', join(out, `${basename(pkg)}-linux-${options.goarch}`), pkg],
        build,
      );
  writeFileSync(stamp, `${new Date().toISOString()}\npkgs: ${want}\n`);
  return out;
}

export function pinsComponents(): Map<string, Component> {
  return new Map(loadPins().components.map((c) => [c.id, c]));
}
