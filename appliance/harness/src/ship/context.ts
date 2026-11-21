/**
 * What every `release/ship` stage works with: where releases are kept, the heavy-work lock, the update channels on
 * GitHub (releases.whombat.com: Beta is the `development` role, Production the `production` role; ONE-03),
 * whombat-cloud's `deploy.sh`, and the DEV instance (its operator API, TUF repository and `WB_MGD_HOME`) only until it
 * is retired (ONE-01: `support --dev` and `release/ship status --dev` read it). Everything can be pointed elsewhere by
 * environment variables (a rehearsal, a stand-in).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHome, REPO_DIR, TMP_DIR } from '../lib/paths.ts';
import { must, type RunOptions, type RunResult, run } from '../lib/proc.ts';
import { flakeAtCommit } from '../lib/source.ts';
import { idsFromTargets } from './ids.ts';

export interface ShipContext {
  /** Where release directories are (`--out-root`, `WB_RELEASES_DIR`, default ~/.cache/whombat-releases). */
  root: string;
  /** Other roots searched for earlier releases' build.json (the default root when `root` is a scratch one). */
  searchRoots: string[];
  repo: string;
  /** Heavy work (ISO builds, harness validate, VM gates) runs under this lock (`WB_HEAVY_LOCK`). */
  heavyLock: string;
  /** Set while this process holds the lock for parts it runs side by side (`holdHeavy`): `heavy()` doesn't take it again. */
  heavyHeld?: boolean;
  /** Logs of this tool's runs. */
  logDir: string;
  dev: {
    /** The DEV instance's WB_MGD_HOME (`WB_DEV_HOME`, default ~/.whombat-stack-dev). */
    home: string;
    tuf: string;
    publicUpdates: string;
  };
  prod: {
    /** The old Hetzner update repository (`WB_UPDATES_URL`): only read, for releases from before ONE-02. */
    updatesUrl: string;
    /**
     * The one update repository, on GitHub Pages (`WB_RELEASES_URL`, default https://releases.whombat.com): its
     * `development` role is Beta, its `production` role Production (ONE-03).
     */
    releasesUrl: string;
    /**
     * whombat-cloud's `infra/hetzner/deploy.sh` (`WB_DEPLOY_SH`; whombat-cloud's ops/bin sets it to the checkout it is
     * in).
     */
    deploySh: string;
  };
}

export const DEFAULT_ROOT = join(homedir(), '.cache', 'whombat-releases');

export function shipContext(outRoot?: string | null): ShipContext {
  const root = expandHome(outRoot ?? process.env.WB_RELEASES_DIR ?? DEFAULT_ROOT);
  const devHome = expandHome(process.env.WB_DEV_HOME ?? '~/.whombat-stack-dev');
  return {
    root,
    searchRoots: [...new Set([root, DEFAULT_ROOT])],
    repo: REPO_DIR,
    heavyLock: expandHome(process.env.WB_HEAVY_LOCK ?? join(TMP_DIR, 'robust-updates-heavy.lock')),
    logDir: join(TMP_DIR, 'ship'),
    dev: {
      home: devHome,
      tuf: join(devHome, 'env', 'manager', 'tuf'),
      publicUpdates: process.env.WB_DEV_UPDATES_URL ?? 'https://updates-dev.whombat.com',
    },
    prod: {
      updatesUrl: process.env.WB_UPDATES_URL ?? 'https://updates.whombat.com',
      releasesUrl: (process.env.WB_RELEASES_URL ?? 'https://releases.whombat.com').replace(/\/+$/, ''),
      deploySh: defaultDeploySh(process.env),
    },
  };
}

/** Where deploy.sh is: `WB_DEPLOY_SH`, else whombat-cloud's. */
export function defaultDeploySh(env: Readonly<Record<string, string | undefined>>): string {
  return expandHome(env.WB_DEPLOY_SH || '~/Code/whombat-cloud/infra/hetzner/deploy.sh');
}

const label = new AsyncLocalStorage<string>();

/** One line to stderr, labelled with the part it comes from when parts run side by side (`labelled`). */
export const say = (s: string) => {
  const l = label.getStore();
  process.stderr.write(`ship: ${l ? `[${l}] ` : ''}${s}\n`);
};

/** Runs `fn` with its `say` lines labelled (nested labels join: `validate live`). */
export function labelled<T>(l: string, fn: () => Promise<T>): Promise<T> {
  const outer = label.getStore();
  return label.run(outer ? `${outer} ${l}` : l, fn);
}

/**
 * Two parts side by side: waits for both even when one fails (the other may be halfway through a rollout or a VM),
 * then throws the first failure.
 */
export async function together<A, B>(a: () => Promise<A>, b: () => Promise<B>): Promise<[A, B]> {
  const [x, y] = await Promise.allSettled([a(), b()]);
  if (x.status === 'rejected') throw x.reason;
  if (y.status === 'rejected') throw y.reason;
  return [x.value, y.value];
}

/**
 * A checkout's `release/build` (`release/build-proxmox` before PI-22, for a worktree of an older commit). `dir` is the
 * appliance's folder, or the top of a Whombat checkout that has it in `appliance/`.
 */
export function buildScript(dir: string): string {
  for (const base of [dir, join(dir, 'appliance')]) {
    const p = join(base, 'release', 'build');
    if (existsSync(p)) return p;
  }
  return join(dir, 'release', 'build-proxmox');
}

/** A command under the heavy-work lock (`flock`), output to a log (and our stderr with `echo`). */
export function heavy(ctx: ShipContext, cmd: string, args: string[], o: RunOptions): Promise<RunResult> {
  if (ctx.heavyHeld) return run(cmd, args, o);
  return run('flock', [ctx.heavyLock, cmd, ...args], o);
}

/**
 * Takes the heavy lock once for parts that run side by side (validate's scenarios, live environment and VM gates) and
 * holds it until `release()`: a `flock … cat` child whose stdin is ours, so the lock goes when we do, even killed.
 * Returns the context to run them with (`heavyHeld`) and the release.
 */
export async function holdHeavy(
  ctx: ShipContext,
): Promise<{ ctx: ShipContext; release: () => Promise<void> }> {
  const child = spawn('flock', [ctx.heavyLock, 'sh', '-c', 'echo held; exec cat >/dev/null'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const waiting = setTimeout(
    () => say(`waiting for the heavy lock ${ctx.heavyLock} (other heavy work holds it)`),
    3000,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d: Buffer) => {
        if (d.toString().includes('held')) resolve();
      });
      child.on('exit', (code) =>
        reject(new Error(`flock ${ctx.heavyLock} exited (${code}) before taking the lock`)),
      );
      child.on('error', reject);
    });
  } finally {
    clearTimeout(waiting);
  }
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return {
    ctx: { ...ctx, heavyHeld: true },
    release: async () => {
      child.stdin.end();
      await exited;
    },
  };
}

export async function git(repo: string, args: string[]): Promise<string> {
  return (await must('git', ['-C', repo, ...args], { cwd: repo })).stdout.trim();
}

/**
 * The appliance flake at a commit (never the working tree: a release is rebuilt from its build.json). The commit is
 * looked for in `repo`'s checkout and then in the archives, and the flake is named for where the appliance is in it
 * (`lib/source.ts`).
 */
export const flakeAt = (repo: string, rev: string) => flakeAtCommit(rev, { checkout: repo });

const NIX = ['--extra-experimental-features', 'nix-command flakes'];

export async function nixEval(expr: string, cwd: string, json = false): Promise<string> {
  const r = await must('nix', [...NIX, 'eval', '--impure', json ? '--json' : '--raw', '--expr', expr], {
    cwd,
    timeoutMs: 1_800_000,
  });
  return r.stdout.trim();
}

export async function nixBuild(installable: string, cwd: string, log?: string): Promise<string> {
  const r = await must('nix', [...NIX, 'build', '--no-link', '--print-out-paths', installable], {
    cwd,
    timeoutMs: 3_600_000,
    ...(log ? { logFile: log } : {}),
  });
  return r.stdout.trim().split('\n').at(-1) ?? '';
}

/** `tufrepo` of the commit being released (`WB_TUFREPO` overrides). */
export async function tufrepo(ctx: ShipContext, rev: string, repo = ctx.repo): Promise<string> {
  if (process.env.WB_TUFREPO) return process.env.WB_TUFREPO;
  return join(await nixBuild(`${flakeAt(repo, rev)}#whombat-release-tools`, repo), 'bin', 'tufrepo');
}

/* The DEV instance's operator API ------------------------------------------------------------------------- */

export interface DevControl {
  adminUrl: string;
  token: string;
  /** The public control origin (what boxes and clients use). */
  publicUrl: string;
}

export function devControl(ctx: ShipContext): DevControl {
  const file = join(ctx.dev.home, 'env', 'env.json');
  if (!existsSync(file)) throw new Error(`no DEV instance at ${ctx.dev.home} (WB_DEV_HOME)`);
  const env = JSON.parse(readFileSync(file, 'utf8')) as {
    control?: { adminUrl: string; url: string; operatorTokenFile: string };
  };
  if (!env.control) throw new Error(`${file} has no control`);
  return {
    adminUrl: env.control.adminUrl,
    token: readFileSync(env.control.operatorTokenFile, 'utf8').trim(),
    publicUrl: process.env.WB_DEV_CONTROL_URL ?? 'https://api-dev.whombat.com',
  };
}

export class OperatorError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, what: string) {
    const code = (body as { error?: { code?: string; message?: string } } | null)?.error;
    super(
      `${what}: ${status}${code?.code ? ` ${code.code}` : ''}${code?.message ? ` (${code.message})` : ''}`,
    );
    this.status = status;
    this.body = body;
  }
}

export async function devOp<T>(c: DevControl, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${c.adminUrl}/v1/operator${path}`, {
    method,
    headers: {
      authorization: `Bearer ${c.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep the text
  }
  if (!res.ok) throw new OperatorError(res.status, parsed, `${method} /v1/operator${path}`);
  return parsed as T;
}

/* Production's operator API through deploy.sh (on the host, over SSH) ------------------------------------- */

/**
 * `deploy.sh op <METHOD> <path> [body.json]`: the body of control's answer on stdout (control HZ-3x, agent A).
 * Null when this deploy.sh has no `op` command yet.
 */
export async function prodOp<T>(
  ctx: ShipContext,
  method: string,
  path: string,
  body?: string,
): Promise<T | null> {
  if (!existsSync(ctx.prod.deploySh)) throw new Error(`no deploy.sh at ${ctx.prod.deploySh} (WB_DEPLOY_SH)`);
  const r = await run(ctx.prod.deploySh, ['op', method, path, ...(body ? [body] : [])], {
    cwd: join(ctx.prod.deploySh, '..', '..', '..'),
    timeoutMs: 120_000,
  });
  if (r.code !== 0) {
    if (/usage|unknown|not a component/i.test(r.stderr) && !r.stdout.trim()) return null;
    throw new Error(`deploy.sh op ${method} ${path} failed (${r.code}): ${r.stderr.trim().slice(-400)}`);
  }
  return JSON.parse(r.stdout) as T;
}

/* TUF metadata over HTTPS (read only) ----------------------------------------------------------------------- */

/** Release ids a repository publishes (timestamp → snapshot → targets; names only, nothing verified). */
export async function publishedReleaseIds(base: string): Promise<string[] | null> {
  try {
    const get = async (p: string) => {
      const r = await fetch(`${base}/metadata/${p}`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`${p}: ${r.status}`);
      return (await r.json()) as { signed: Record<string, unknown> };
    };
    const ts = await get('timestamp.json');
    const snapV = (ts.signed.meta as Record<string, { version: number }>)['snapshot.json']?.version;
    const snap = await get(`${snapV}.snapshot.json`);
    const tV = (snap.signed.meta as Record<string, { version: number }>)['targets.json']?.version;
    const targets = await get(`${tV}.targets.json`);
    return idsFromTargets(Object.keys(targets.signed.targets as Record<string, unknown>));
  } catch {
    return null;
  }
}

/** The update channels' role names (ONE-03): people see Beta and Production. */
export type Channel = 'development' | 'production';
export const CHANNEL_WORDS: Record<Channel, string> = { development: 'Beta', production: 'Production' };

/** Release ids a channel role lists (`<channel>/releases/<id>.json`). */
export function channelIdsOf(targets: Iterable<string>, channel: Channel): string[] {
  const out: string[] = [];
  const re = new RegExp(`^${channel}/releases/(?:[0-9a-f]{64}\\.)?([^/]+)\\.json$`);
  for (const t of targets) {
    const m = re.exec(t);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/**
 * Release ids a channel of the published repository lists (timestamp → snapshot → the channel's role; names only,
 * nothing verified: `tufrepo check-newer --channel` verifies). The GitHub layout serves metadata at the site's root.
 * Null when unreadable.
 */
export async function channelReleaseIds(base: string, channel: Channel): Promise<string[] | null> {
  try {
    const get = async (p: string) => {
      const r = await fetch(`${base.replace(/\/+$/, '')}/${p}`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`${p}: ${r.status}`);
      return (await r.json()) as { signed: Record<string, unknown> };
    };
    const ts = await get('timestamp.json');
    const snapV = (ts.signed.meta as Record<string, { version: number }>)['snapshot.json']?.version;
    const snap = await get(`${snapV}.snapshot.json`);
    const v = (snap.signed.meta as Record<string, { version: number }>)[`${channel}.json`]?.version;
    if (!v) return [];
    const role = await get(`${v}.${channel}.json`);
    return channelIdsOf(Object.keys(role.signed.targets as Record<string, unknown>), channel);
  } catch {
    return null;
  }
}

/**
 * Release ids a channel lists in the publisher's clone of whombat-releases (`WHOMBAT_RELEASES_DIR`): its newest
 * `<N>.<channel>.json`, which the publisher signs itself (the workflow only adds snapshot and timestamp). Null without
 * one.
 */
export function cloneChannelIds(dir: string, channel: Channel): string[] | null {
  const meta = join(dir, 'metadata');
  if (!existsSync(meta)) return null;
  let best = 0;
  for (const f of readdirSync(meta)) {
    const m = new RegExp(`^(\\d+)\\.${channel}\\.json$`).exec(f);
    if (m?.[1]) best = Math.max(best, Number(m[1]));
  }
  if (!best) return null;
  const role = JSON.parse(readFileSync(join(meta, `${best}.${channel}.json`), 'utf8')) as {
    signed: { targets: Record<string, unknown> };
  };
  return channelIdsOf(Object.keys(role.signed.targets), channel);
}
