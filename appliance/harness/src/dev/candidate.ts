/**
 * The maintainers' `candidate --what "…" [--why "…"]` — one command from a commit of this repository's `main` to a
 * release in Beta and, when they changed, the hosted parts on production (ONE-01, ONE-19; Whombat
 * docs/decisions/one-repo.md). A release is one commit of `main`: nothing is pinned, and most runs commit nothing.
 *
 *   1. Start: a fresh worktree of origin/main (a dry run: of what is checked out here).
 *   2. The hosted plan: with `--cloud <rev>`, what whombat-cloud's `deploy.sh plan` says for control and the relay;
 *      whether the commit's web differs from what app.whombat.com runs; and that control speaks the contracts the
 *      commit is built with.
 *   3. The box's release (dev/release-plan.ts): the fixed hashes (refreshed when one is stale), the agents (signed
 *      again only when their bytes changed), the runtime (kept while it is the published object, else a new one
 *      stamped with this commit) and the image (a host release when it differs from the one Beta's boxes run).
 *   4. Nothing to deploy and nothing changed: “nothing to ship”, and the run ends.
 *   5. `plan.json` in the run's folder, before any release is built. A run that carries on reads it and decides
 *      nothing again.
 *   6. Release prep, only when a fixed hash was refreshed or the agents were signed: one commit of those generated
 *      files on `main` (“release: refresh …”), pushed. The release is built from it.
 *   7. `release/ship build <id>` from the release commit, with the plan's choices.
 *   8. The hosted parts on production with whombat-cloud's `infra/hetzner/deploy.sh`: control and the relay, then the
 *      account site and the embed, each after production control was heard to speak the contracts.
 *   9. Beta: `tufrepo gh-publish`, which every Beta box (Home among them) takes within the hour. Production only with
 *      the maintainers' `promote <id> --yes`, on John's word.
 *  10. The record (`records/releases/<version>.json`) and the releases runbook's section, committed in whombat-ops.
 *
 *   candidate --what "deleting in Chat works again" [--why "John couldn't delete messages in Chat."]
 *             [--cloud <whombat-cloud rev on its main>] [--version x.y.z | --minor] [--host] [--new]
 *             [--co-author "Name <email>"] [--dry-run]
 *
 * The run is one of five kinds (`release-plan.ts` `Kind`): a host release with a new runtime, a host release that
 * keeps the published runtime, a runtime-only release, hosted parts only, or nothing. `--host` forces a host release.
 * No validation (IN-132). When a run stopped, the same command carries on after the last step its plan records; a run
 * whose commit left `main`, or that was asked for something else (another `--cloud` or `--version`, or `--new`),
 * starts a new plan under the next number. Numbers
 * count from the release records in whombat-ops; the first is one minor above the old flow's last candidate.
 * `--legacy-version` prints the number a release by the old flow takes meanwhile (the legacy-release runbook).
 * `--dry-run` does steps 1 to 5 and says what the rest would do; it keeps nothing and signs nothing. While
 * ~/.config/whombat/candidate-freeze exists every run refuses, except a dry run. When a run ends it removes the copies
 * of the source tree it left in the Nix store (340 MB a commit), when nothing refers to them, and says how much that
 * freed.
 * Everything is logged to ~/.cache/wb-tmp/rel-<version>/ (plan.json, candidate.log, build.log, hosted-*.log,
 * github.log, summary.json). WHOMBAT_CLOUD names the whombat-cloud checkout, WB_DEPLOY_SH its deploy.sh,
 * WB_PROD_APP_URL the account site and WB_PROD_CONTROL_URL control. WB_CANDIDATE_STOP_AFTER=<step> ends a run after
 * that step, for a rehearsal of carrying on.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { guardsFile, opsCommand, opsDir } from '../lib/guards.ts';
import { expandHome, REPO_DIR, TMP_DIR } from '../lib/paths.ts';
import { must, type RunOptions, run } from '../lib/proc.ts';
import {
  archives,
  treeFlake as checkoutFlake,
  fileAt,
  findSource,
  flakeOf,
  samePathsAt,
  topOf,
} from '../lib/source.ts';
import { cloneChannelIds, DEFAULT_ROOT, shipContext } from '../ship/context.ts';
import * as plan from './candidate-plan.ts';
import * as release from './release-plan.ts';
import { commitRunbook } from './runbook.ts';
import { tufrepoBin } from './tufrepo.ts';

const HOME = homedir();
/** Where the release builds are kept (WB_RELEASES_DIR, as `release/ship` reads it; default ~/.cache/whombat-releases). */
const RELEASES = expandHome(process.env.WB_RELEASES_DIR ?? DEFAULT_ROOT);
const NIX = {
  NIX_CONFIG: `${process.env.NIX_CONFIG ?? ''}\nextra-experimental-features = nix-command flakes`,
};

export interface Args {
  what: string;
  why: string;
  /**
   * `--cloud`: the whombat-cloud commit whose control and relay go to production, each when its folder changed
   * (ONE-19); null leaves both as they are.
   */
  cloud: string | null;
  version: string | null;
  minor: boolean;
  /** `--host`: a host release even when the image is the one Beta's boxes run. */
  host: boolean;
  /** `--new`: a new plan under the next number, even when a stopped run could carry on. */
  fresh: boolean;
  coAuthor: string | null;
  dryRun: boolean;
}

/** The environment variables the Beta publish needs: the publisher's clone of whombat-releases and its token. */
export const GITHUB_DIR_ENV = plan.RELEASES_DIR_ENV;
export const GITHUB_TOKEN_ENV = plan.RELEASES_TOKEN_ENV;

const USAGE =
  'usage: candidate --what "<what changed, lower case>" [--why "<why, one sentence>"] [--cloud <whombat-cloud rev>] [--version x.y.z | --minor] [--host] [--new] [--co-author "Name <email>"] [--dry-run]\n       candidate --legacy-version   (the number a release by the old flow takes now)';

/**
 * Options that are gone: the ones that went with DEV (ONE-01), control's and the relay's own from when each was a
 * repository, and the ones that named a commit of another repository when a release pinned three.
 */
const GONE: Record<string, string> = {
  '--whombat':
    '--whombat went with the pins: a release is a commit of this repository’s main, and the candidate ships origin/main. Merge and push what should ship',
  '--hosts':
    '--hosts went with the pins: the hosts service is hosts/ of this repository. The candidate signs the agents when their bytes changed and makes a host release when the hub did',
  '--reuse-host':
    '--reuse-host went with the pins: the candidate compares the image with the one Beta’s boxes run and reuses that host by itself. --host forces a host release',
  '--api':
    '--api went with control’s own repository: control is whombat-cloud’s control/ now. Use --cloud <a commit on whombat-cloud’s main>; it deploys control when control/ changed',
  '--relay':
    '--relay went with the relay’s own repository: the relay is whombat-cloud’s relay/ now. Use --cloud <a commit on whombat-cloud’s main>; it deploys the relay when relay/ changed',
  '--github': '--github went with DEV (ONE-01): every release goes to Beta, on GitHub',
  '--no-rollout':
    '--no-rollout went with DEV (ONE-01): Beta has no rollouts; a release is in Beta or it is not',
};

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Args {
  const a: Args = {
    what: '',
    why: '',
    cloud: null,
    version: null,
    minor: false,
    host: false,
    fresh: false,
    // Claude Code runs it most of the time; its commits carry the trailer the repo's others do.
    coAuthor: env.CLAUDECODE === '1' ? 'Claude Opus 5.5 <noreply@anthropic.com>' : null,
    dryRun: false,
  };
  const value = (i: number, name: string) => {
    const v = argv[i];
    if (!v || v.startsWith('--')) throw new Error(`${name} needs a value\n${USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const o = argv[i] as string;
    if (o === '--what') a.what = value(++i, o).replace(/\.$/, '');
    else if (o === '--why') a.why = value(++i, o);
    else if (o === '--cloud') a.cloud = value(++i, o);
    else if (o === '--version') {
      a.version = value(++i, o);
      if (!/^\d+\.\d+\.\d+$/.test(a.version)) throw new Error('--version takes x.y.z');
    } else if (o === '--minor') a.minor = true;
    else if (o === '--host') a.host = true;
    else if (o === '--new') a.fresh = true;
    else if (o === '--co-author') a.coAuthor = value(++i, o);
    else if (o === '--dry-run') a.dryRun = true;
    else if (GONE[o]) throw new Error(GONE[o]);
    else if (o === '-h' || o === '--help') throw new Error(USAGE);
    else throw new Error(`unknown argument ${o}\n${USAGE}`);
  }
  if (!a.what)
    throw new Error(`--what is needed: it names the candidate in commits and the runbook\n${USAGE}`);
  return a;
}

/** The candidate freeze (`plan.freezeMessage`): null when this run may go on. A dry run may. */
export function frozen(
  a: Pick<Args, 'dryRun'>,
  env: NodeJS.ProcessEnv = process.env,
  home = HOME,
): string | null {
  if (a.dryRun) return null;
  const file = plan.freezeFile(env, home);
  if (!existsSync(file)) return null;
  return plan.freezeMessage(file, readFileSync(file, 'utf8'));
}

/**
 * A stage that publishes or deploys, run only while no freeze is on (`frozen`): a run that started before the freeze
 * was set (or a direct run of this file, without the wrapper's lock) is checked again right before it.
 */
export async function unfrozenStage<T>(
  a: Pick<Args, 'dryRun'>,
  name: string,
  fn: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
  home = HOME,
): Promise<T> {
  const freeze = frozen(a, env, home);
  if (freeze) throw new Error(`the freeze came while this run was under way, before it published: ${freeze}`);
  return stage(name, fn);
}

const started = Date.now();
let log = join(TMP_DIR, 'dev-candidate.log');
const say = (s: string) => process.stderr.write(`candidate: ${s}\n`);
const secs = (ms: number) => `${Math.round(ms / 1000)} s`;
const mins = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};
const times: [string, number][] = [];
let current = 'start';

async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  current = name;
  say(`${name}…`);
  const out = await fn();
  times.push([name, Date.now() - t]);
  say(`${name}: done in ${secs(Date.now() - t)}`);
  return out;
}

/** Its own scope with a MemoryHigh for a command that reads many files (`plan.memoryHighFor`). */
const scope = (cmd: string): Partial<RunOptions> => {
  const memoryHigh = plan.memoryHighFor(cmd);
  return memoryHigh ? { memoryHigh } : {};
};
const sh = (cmd: string, args: readonly string[], cwd: string, o: Partial<RunOptions> = {}) =>
  must(cmd, args, { cwd, logFile: log, timeoutMs: 20 * 60_000, ...scope(cmd), ...o });
const git = async (cwd: string, ...args: string[]) => (await sh('git', args, cwd)).stdout.trim();
const ok = async (cmd: string, args: readonly string[], cwd: string) =>
  (await run(cmd, args, { cwd, logFile: log, timeoutMs: 5 * 60_000, ...scope(cmd) })).code === 0;

/**
 * The release builds kept here (~/.cache/whombat-releases/whombat-*, and pve-* from before PI-23), with their image's
 * environment, twin (before ONE-02), Whombat, host and candidate.
 */
function builds(): plan.BuiltRelease[] {
  if (!existsSync(RELEASES)) return [];
  return readdirSync(RELEASES)
    .filter((id) => /^(whombat|pve)-\d{8}\.\d+$/.test(id))
    .map((id) => {
      try {
        const b = JSON.parse(readFileSync(join(RELEASES, id, 'build.json'), 'utf8')) as {
          env?: string;
          ship?: { twin?: { releaseId?: string } | null; candidate?: { name?: string } };
          runtime?: { whombatRev?: string };
          tuple?: { host?: { version?: string } };
          source?: { rev?: string };
        };
        return {
          id,
          env: b.env ?? null,
          twin: b.ship?.twin?.releaseId ?? null,
          whombatRev: b.runtime?.whombatRev ?? null,
          host: b.tuple?.host?.version ?? null,
          candidate: b.ship?.candidate?.name ?? null,
          sourceRev: b.source?.rev ?? null,
        };
      } catch {
        return { id, env: null, twin: null, whombatRev: null, host: null, candidate: null, sourceRev: null };
      }
    });
}

/**
 * `--cloud <rev>` as a full commit of whombat-cloud's main (`main` meaning origin's), with its subject. deploy.sh and Nix take it from the checkout the candidate names (`source`) by branch or tag, so the
 * commit has to be on one there: a checkout on main without changes is fast-forwarded to origin/main (`fix`; the dry
 * run only says so), otherwise it stops before anything changed.
 */
async function resolveCloud(
  src: string,
  rev: string,
  fix: boolean,
  name = 'whombat-cloud',
): Promise<{ rev: string; subject: string }> {
  await git(src, 'fetch', '-q', 'origin');
  const r = await run(
    'git',
    ['rev-parse', '--verify', '-q', `${rev === 'main' ? 'origin/main' : rev}^{commit}`],
    {
      cwd: src,
      ...scope('git'),
    },
  );
  const full = r.stdout.trim();
  if (r.code !== 0 || !full) throw new Error(`${name} has no commit ${rev} (${src}, after fetching origin)`);
  const short = full.slice(0, 7);
  if (!(await ok('git', ['merge-base', '--is-ancestor', full, 'origin/main'], src)))
    throw new Error(`${name} ${short} is not on its origin/main: merge and push it first`);
  const onBranch = async () =>
    (await git(
      src,
      'for-each-ref',
      '--count=1',
      '--contains',
      full,
      '--format=%(refname)',
      'refs/heads',
      'refs/tags',
    )) !== '';
  if (!(await onBranch())) {
    const branch = (
      await run('git', ['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: src, ...scope('git') })
    ).stdout.trim();
    const clean = (await git(src, 'status', '--porcelain')) === '';
    const advice = `${src} has ${name} ${short} on no branch: \`git -C ${src} merge --ff-only origin/main\` on its main`;
    if (!fix) say(`${advice} (a real run does it when that checkout is on main without changes)`);
    else if (
      branch === 'main' &&
      clean &&
      (await ok('git', ['merge', '--ff-only', '-q', 'origin/main'], src)) &&
      (await onBranch())
    )
      say(`${src} fast-forwarded to origin/main: it has ${name} ${short} on main now`);
    else
      throw new Error(
        `${advice} (it is on ${branch || 'no branch'}${clean ? '' : ', with changes'}), then run again`,
      );
  }
  return { rev: full, subject: await git(src, 'log', '-1', '--format=%s', full) };
}

/** Fast-forwards the checkout this runs from, when it is on main without changes; otherwise says why not. */
async function fastForward(repo: string): Promise<void> {
  const branch = (
    await run('git', ['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: repo, ...scope('git') })
  ).stdout.trim();
  const dirty = (await git(repo, 'status', '--porcelain')) !== '';
  if (branch === 'main' && !dirty && (await ok('git', ['merge', '--ff-only', '-q', 'origin/main'], repo)))
    return;
  say(
    `${repo} left as it is (${branch || 'detached'}${dirty ? ', with changes' : ''}); origin/main has the candidate`,
  );
}

/**
 * Whether the account site goes to production with Whombat `rev` (`plan.webDecision`): the commit app.whombat.com's
 * `version.json` names, compared with `rev` over `plan.WEB_PATHS` in the Whombat checkout.
 */
async function webDecision(whombat: string, rev: string): Promise<{ deploy: boolean; why: string }> {
  const base = (process.env.WB_PROD_APP_URL ?? 'https://app.whombat.com').replace(/\/+$/, '');
  let text: string | null = null;
  try {
    const r = await fetch(`${base}/version.json`, { signal: AbortSignal.timeout(15_000) });
    text = r.ok ? await r.text() : null;
  } catch {
    text = null;
  }
  const deployed = plan.webBuildCommit(text);
  // The commit production's web was built from may be in this checkout or only in an archive (a checkout of the
  // published repository holds no commit from before it was published): its files are compared wherever it is.
  const same = deployed ? samePathsAt(deployed, rev, plan.WEB_PATHS, { checkout: whombat }) : null;
  return plan.webDecision({ deployed, rev, changed: same === null ? null : !same });
}

/** The contracts version production control speaks now (`/v1/health`, WB_PROD_CONTROL_URL), or null when unknown. */
async function liveControlContracts(): Promise<string | null> {
  const base = (process.env.WB_PROD_CONTROL_URL ?? 'https://api.whombat.com').replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(15_000) });
    return plan.healthContracts(r.ok ? await r.text() : null);
  } catch {
    return null;
  }
}

/** The hosted deploys a stopped run made already (`hosted.json`). */
function hostedDone(rel: string): plan.HostedDeploy[] {
  const f = join(rel, 'hosted.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as plan.HostedDeploy[]) : [];
}

/**
 * The whombat-cloud checkout (`WHOMBAT_CLOUD`, default ~/Code/whombat-cloud): control and the relay are built from its
 * commits, by its own deploy.sh.
 */
function cloudCheckout(): { dir: string; deploySh: string } {
  const dir = expandHome(process.env.WHOMBAT_CLOUD || plan.CLOUD_CHECKOUT);
  const deploySh = join(dir, 'infra', 'hetzner', 'deploy.sh');
  if (!existsSync(deploySh))
    throw new Error(
      `no whombat-cloud checkout at ${dir} (WHOMBAT_CLOUD; whombat-ops bin/candidate names the checkout it is in): --cloud needs it`,
    );
  return { dir, deploySh };
}

/**
 * What a deploy of whombat-cloud `rev` does to control and the relay (`deploy.sh plan`): it reads what the server runs
 * and changes nothing.
 */
async function cloudPlan(deploySh: string, rev: string): Promise<plan.CloudPlanPart[]> {
  const r = await run(deploySh, ['plan', rev], {
    cwd: join(deploySh, '..', '..', '..'),
    logFile: log,
    timeoutMs: 2 * 60_000,
  });
  if (r.code !== 0)
    throw new Error(
      `deploy.sh plan ${rev.slice(0, 12)} failed (${r.code}): ${r.stderr.trim().split('\n').slice(-3).join(' ')}`,
    );
  return plan.parseCloudPlan(r.stdout);
}

/** One hosted part on production with deploy.sh (its fleet check, dump and previous build are its own). */
async function deployHosted(rel: string, h: plan.HostedDeploy, deploySh: string): Promise<void> {
  if (!existsSync(deploySh)) throw new Error(`no deploy.sh at ${deploySh} (WB_DEPLOY_SH)`);
  const r = await run(deploySh, plan.deployArgs(h), {
    cwd: join(deploySh, '..', '..', '..'),
    logFile: join(rel, `hosted-${h.part}.log`),
    timeoutMs: 40 * 60_000,
  });
  if (r.code !== 0)
    throw new Error(
      `deploy.sh ${h.part} ${h.ref.slice(0, 12)} failed (${r.code}; ${join(rel, `hosted-${h.part}.log`)}): ${r.stderr.trim().split('\n').slice(-3).join(' ')}. Fix the cause and run the candidate again (what deployed already is left out); to go back: deploy.sh rollback ${h.part === 'control' ? 'control [--restore <dump>]' : h.part}`,
    );
  const done = [...hostedDone(rel), h];
  writeFileSync(join(rel, 'hosted.json'), `${JSON.stringify(done, null, 2)}\n`);
  say(`${h.part} at ${h.ref.slice(0, 12)} is live on production`);
}

const trailer = (a: Args) => (a.coAuthor ? `\n\nCo-Authored-By: ${a.coAuthor}` : '');

/** A commit's stamp: its id and its commit time. */
async function stampAt(repo: string, rev: string): Promise<release.Stamp> {
  return release.stampOf(rev, Number(await git(repo, 'show', '-s', '--format=%ct', rev)));
}

/** A release's build.json here, or null. */
function buildOf(id: string | null): Record<string, unknown> | null {
  if (!id) return null;
  const file = join(RELEASES, id, 'build.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null;
}

/**
 * The runtime Beta's newest release published, from its build.json: its stamp (recorded by a build of the one
 * repository; for a build from before, the Whombat commit it pinned and that commit's time), its store path and hash.
 */
async function publishedRuntime(repo: string, id: string | null): Promise<release.PublishedRuntime | null> {
  const b = buildOf(id) as {
    runtime?: { whombatRev?: string; stamp?: release.Stamp };
    tuple?: { runtime?: { storePath?: string; narHash?: string } };
  } | null;
  const t = b?.tuple?.runtime;
  if (!id || !b || !t?.storePath || !t.narHash) return null;
  if (b.runtime?.stamp)
    return { release: id, stamp: b.runtime.stamp, storePath: t.storePath, narHash: t.narHash };
  const rev = b.runtime?.whombatRev;
  if (!rev || !(await ok('git', ['cat-file', '-e', `${rev}^{commit}`], repo))) return null;
  return { release: id, stamp: await stampAt(repo, rev), storePath: t.storePath, narHash: t.narHash };
}

/**
 * What this run had Nix read: commits (each is a copy of the commit's whole tree in the Nix store) and, for a tree
 * with generated files not yet committed, the copies of that tree as it was. The run removes them again when it ends
 * (`dropSourceCopies`).
 */
const revsRead = new Set<string>();
const copiesSeen = new Set<string>();

/** The appliance's flake at a commit of this repository. */
const flakeAt = (repo: string, rev: string) => {
  revsRead.add(rev);
  return flakeOf(findSource(rev, { checkout: repo }));
};

/** The store path Nix copied a flake's tree to (the copy is made when it isn't there). */
async function copyOf(flake: string): Promise<string | null> {
  const r = await run('nix', ['flake', 'metadata', '--json', flake], {
    cwd: TMP_DIR,
    env: NIX,
    timeoutMs: 5 * 60_000,
  });
  try {
    return r.code === 0 ? ((JSON.parse(r.stdout) as { path?: string }).path ?? null) : null;
  } catch {
    return null;
  }
}

/** Notes the copy of a tree as it is now (a worktree with uncommitted generated files), right after Nix read it. */
async function sawTree(flake: string): Promise<void> {
  const path = await copyOf(flake);
  if (path) copiesSeen.add(path);
}

/**
 * Removes the whole-tree copies this run left in the Nix store (`release.dropsCopy`): what the commits and trees it
 * read were copied to, registered since the run began, with no other store path referring to them. `nix-store
 * --delete` refuses a path something roots or a running Nix still uses, and that one stays. Says how much it freed.
 * Never stops a run.
 */
async function dropSourceCopies(repo: string, sinceMs: number): Promise<void> {
  try {
    const since = Math.floor(sinceMs / 1000);
    const paths = new Set(copiesSeen);
    for (const rev of revsRead) {
      let flake: string;
      try {
        flake = flakeOf(findSource(rev, { checkout: repo }));
      } catch {
        continue;
      }
      const path = await copyOf(flake);
      if (path) paths.add(path);
    }
    let dropped = 0;
    let bytes = 0;
    const kept: string[] = [];
    for (const path of paths) {
      const info = await run('nix', ['path-info', '--json', path], {
        cwd: TMP_DIR,
        env: NIX,
        timeoutMs: 60_000,
      });
      let registeredAt: number | null = null;
      let size = 0;
      if (info.code === 0) {
        const j = JSON.parse(info.stdout) as
          | Record<string, { registrationTime?: number; narSize?: number } | null>
          | { registrationTime?: number; narSize?: number }[];
        const entry = Array.isArray(j) ? j[0] : Object.values(j)[0];
        registeredAt = entry?.registrationTime ?? null;
        size = entry?.narSize ?? 0;
      }
      const refs = await run('nix-store', ['--query', '--referrers', path], {
        cwd: TMP_DIR,
        timeoutMs: 60_000,
      });
      const referrers = refs.code === 0 ? refs.stdout.split('\n').filter((p) => p && p !== path) : ['?'];
      const verdict = release.dropsCopy({ path, registeredAt, since, referrers });
      if (!verdict.drop) {
        kept.push(`${path} (${verdict.why})`);
        continue;
      }
      const del = await run('nix-store', ['--delete', path], { cwd: TMP_DIR, timeoutMs: 5 * 60_000 });
      if (del.code === 0) {
        dropped++;
        bytes += size;
      } else kept.push(`${path} (the store keeps it: something roots or uses it)`);
    }
    if (dropped)
      say(
        `removed ${dropped} ${dropped === 1 ? 'copy' : 'copies'} of the source tree this run left in the Nix store: ${Math.round(bytes / 1048576)} MiB freed`,
      );
    for (const k of kept) say(`left in the Nix store: ${k}`);
  } catch (err) {
    say(`this run's copies in the Nix store were not removed (${(err as Error).message.split('\n')[0]})`);
  }
}

/** This commit's runtime store path under a stamp (evaluation only), null when it doesn't evaluate. */
async function runtimeUnder(app: string, flake: string, stamp: release.Stamp): Promise<string | null> {
  const expr = `((builtins.getFlake "${flake}").lib.applianceRelease { env = "prod"; releaseId = "whombat-20990101.1"; runtimeStamp = { rev = "${stamp.rev}"; time = ${stamp.time}; date = "${stamp.date}"; }; }).runtime.outPath`;
  const r = await run('nix', ['eval', '--impure', '--raw', '--expr', expr], {
    cwd: app,
    env: NIX,
    logFile: log,
    timeoutMs: 30 * 60_000,
    ...scope('nix'),
  });
  return r.code === 0 && r.stdout.trim().startsWith('/nix/store/') ? r.stdout.trim() : null;
}

/** The NAR hash of a store path on this machine, as a release tuple names it; null when it isn't there. */
async function storeHash(path: string): Promise<string | null> {
  const r = await run('nix', ['path-info', '--json', path], { cwd: TMP_DIR, env: NIX, timeoutMs: 60_000 });
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout) as Record<string, { narHash?: string }> | { narHash?: string }[];
    const entry = Array.isArray(j) ? j[0] : Object.values(j)[0];
    return entry?.narHash ? release.tupleNarHash(entry.narHash) : null;
  } catch {
    return null;
  }
}

const HOSTS_PKG = join('nix', 'packages', 'hosts');

/**
 * The agents of the tree in `app`: built, and the committed manifest checked against them (0 a match, 3 other bytes,
 * 1 anything else), with where they were built and the checker.
 */
async function checkAgents(
  app: string,
  flake: string,
): Promise<{
  check: release.ManifestCheck;
  detail: string;
  dir: string;
  checker: string;
  committed: string;
}> {
  const built = async (attr: string) =>
    (
      await sh('nix', ['build', '--no-link', '--print-out-paths', `${flake}#${attr}`], app, {
        env: NIX,
        timeoutMs: 40 * 60_000,
      })
    ).stdout
      .trim()
      .split('\n')
      .at(-1) as string;
  const dir = await built('whombat-hosts-agents');
  const checker = join(await built('whombat-hosts.checker'), 'bin', 'whombat-hosts-manifest-check');
  const committed = (
    JSON.parse(readFileSync(join(app, HOSTS_PKG, 'agent-version.json'), 'utf8')) as { version: string }
  ).version;
  const r = await run(
    checker,
    [
      '--manifest',
      join(app, HOSTS_PKG, 'agent-manifest.json'),
      '--key',
      join(app, HOSTS_PKG, 'agent-update-key.pub'),
      '--version',
      committed,
      '--dir',
      dir,
    ],
    { cwd: app, logFile: log },
  );
  const check: release.ManifestCheck = r.code === 0 ? 0 : r.code === 3 ? 3 : 1;
  return { check, detail: r.stderr.trim().split('\n').at(-1) ?? '', dir, checker, committed };
}

/**
 * What may follow the agents servers already have (the checker's `--published`): the manifest of the host release
 * Beta's boxes run, read from that release's commit. Throws with the checker's reason.
 */
async function afterPublished(
  repo: string,
  app: string,
  hostSource: string | null,
  agents: { dir: string; checker: string },
  version: string,
  rel: string,
): Promise<void> {
  const published = hostSource
    ? fileAt(hostSource, join(HOSTS_PKG, 'agent-manifest.json'), { checkout: repo })
    : null;
  if (!published) {
    say('no published agent manifest to compare with (no host release of this image here): skipped');
    return;
  }
  const file = join(rel, 'published-agent-manifest.json');
  writeFileSync(file, published);
  const r = await run(
    agents.checker,
    [
      '--published',
      file,
      '--key',
      join(app, HOSTS_PKG, 'agent-update-key.pub'),
      '--version',
      version,
      '--dir',
      agents.dir,
    ],
    { cwd: app, logFile: log },
  );
  if (r.code !== 0)
    throw new Error(r.stderr.trim().split('\n').at(-1) ?? 'the agents can’t follow the published ones');
}

/** `release/build host-path`: this commit's image as that host release was built; its JSON line. */
async function hostPath(app: string, hostBuildJson: string, rev: string): Promise<{ equal: boolean }> {
  const r = await run(join(app, 'release', 'build'), ['host-path', hostBuildJson, '--rev', rev], {
    cwd: app,
    logFile: log,
    timeoutMs: 30 * 60_000,
    ...scope('nix'),
  });
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').at(-1) ?? `host-path exited ${r.code}`);
  const j = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as { equal?: boolean };
  if (typeof j.equal !== 'boolean') throw new Error(`host-path printed ${r.stdout.trim().slice(-200)}`);
  return { equal: j.equal };
}

/** The candidates the release records hold (whombat-ops records/releases/<version>.json), and the runs' folders. */
function knownVersions(ops: string | null): string[] {
  const names = (dir: string, re: RegExp) =>
    existsSync(dir)
      ? readdirSync(dir)
          .map((f) => re.exec(f)?.[1])
          .filter((v): v is string => !!v)
      : [];
  return [
    ...(ops ? names(join(ops, 'records', 'releases'), /^(\d+\.\d+\.\d+)\.json$/) : []),
    ...names(TMP_DIR, /^rel-(\d+\.\d+\.\d+)$/).filter((v) =>
      existsSync(join(TMP_DIR, `rel-${v}`, 'plan.json')),
    ),
  ];
}

/**
 * The old flow's candidates: the names of its candidate manifests, which are in `manifest/candidates/` here until
 * releases move to this repository and in whombat-ops' `records/candidates/` afterwards.
 */
export function legacyCandidates(ops: string | null, appliance = REPO_DIR): string[] {
  const out: string[] = [];
  for (const dir of [
    ...(ops ? [join(ops, 'records', 'candidates')] : []),
    join(appliance, 'manifest', 'candidates'),
  ])
    if (existsSync(dir)) for (const f of readdirSync(dir)) out.push(f.replace(/\.json$/, ''));
  return out;
}

/** The newest plan here that this run carries on with (`release.resumes`), or null. */
async function planToResume(
  repo: string,
  a: Args,
  cloud: string | null,
): Promise<release.ReleasePlan | null> {
  const versions = knownVersions(null)
    .map((v) => ({ v, n: v.split('.').map(Number) as [number, number, number] }))
    .sort((x, y) => y.n[0] - x.n[0] || y.n[1] - x.n[1] || y.n[2] - x.n[2]);
  for (const { v } of versions) {
    let p: release.ReleasePlan;
    try {
      p = release.parsePlan(readFileSync(join(TMP_DIR, `rel-${v}`, 'plan.json'), 'utf8'));
    } catch {
      continue;
    }
    // A plan whose release-prep commit is not pushed yet carries on only while main is still the commit it was made
    // for (the push is a fast-forward of exactly that) and the commit is still here. Any other plan carries on while
    // the commit its release is built from is on main.
    const prepPending = release.needsPrep(p) && !p.done.includes('prep');
    const onMain = prepPending
      ? (await git(repo, 'rev-parse', 'origin/main')) === p.commit &&
        !!p.prep.commit &&
        (await ok('git', ['cat-file', '-e', `${p.prep.commit}^{commit}`], repo))
      : await ok('git', ['merge-base', '--is-ancestor', release.releaseCommit(p), 'origin/main'], repo);
    const r = release.resumes(p, { cloud, version: a.version, onMain, fresh: a.fresh });
    if (r.resume) {
      say(`carrying on: ${r.why}`);
      return p;
    }
    if (release.nextStep(p) !== null) say(`a new plan: ${r.why}`);
    // Only the newest plan is a run that may carry on.
    return null;
  }
  return null;
}

function savePlan(rel: string, p: release.ReleasePlan): void {
  writeFileSync(join(rel, 'plan.json'), `${JSON.stringify(p, null, 2)}\n`);
}

/** Marks a step done in the plan; a rehearsal ends the run here (`WB_CANDIDATE_STOP_AFTER`). */
function stepDone(rel: string, p: release.ReleasePlan, step: release.Step): void {
  if (!p.done.includes(step)) p.done.push(step);
  savePlan(rel, p);
  if (process.env.WB_CANDIDATE_STOP_AFTER === step) {
    say(`stopped after “${step}”, as asked (WB_CANDIDATE_STOP_AFTER); the same command carries on`);
    process.exit(3);
  }
}

/** The run's section in the releases runbook. */
export function runbookSection(r: release.ReleaseRecord, total: string): string {
  const lines = [
    `## ${r.releaseId ?? 'hosted parts only'} — candidate ${r.version}, ${r.at.slice(0, 10)}`,
    '',
    `${r.what.charAt(0).toUpperCase()}${r.what.slice(1)}.${r.why ? ` ${r.why}` : ''}`,
    '',
    `- ${release.KIND_WORDS[r.kind]}, from Whombat \`${r.commit.slice(0, 12)}\`, in ${total}.`,
  ];
  if (r.releaseId) {
    lines.push(
      r.runtime.kept
        ? `- The runtime is ${r.runtime.from}'s, kept (${r.runtime.version ?? 'unchanged'}).`
        : `- A new runtime ${r.runtime.version ?? ''}, stamped \`${r.runtime.stamp.rev.slice(0, 12)}\`.`,
      `- Agents ${r.agents.version}${r.agents.signed ? ', signed with this release' : ', unchanged'}.`,
      r.host.reuse ? `- On the host of ${r.host.reuse}.` : '- A host release.',
      `- Contracts ${r.contracts}. In Beta; Production with \`promote ${r.releaseId} --yes\`, on John's word.`,
    );
  }
  lines.push(
    r.hosted.length
      ? `- On production: ${r.hosted.map((h) => `${h.part} at \`${h.ref.slice(0, 12)}\``).join(', ')}.`
      : '- Nothing hosted was deployed.',
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const freeze = frozen(a);
  if (freeze) throw new Error(freeze);
  // What a release builds is scanned against the maintainers' guard list; a run that needs the list refuses without it.
  if (process.env.WHOMBAT_GUARDS_REQUIRED === '1' && !guardsFile(REPO_DIR))
    throw new Error('no guard list (whombat-ops guards/forbid.txt): a candidate needs it');
  // Every box reads only the GitHub repository (LNK-50, ONE-02): without its clone and token nothing starts.
  const github = plan.releasesTarget(process.env);
  const beta = cloneChannelIds(github.dir, 'development');
  if (!beta)
    throw new Error(
      `${github.dir} has no Beta channel (metadata/<N>.development.json): is it the publisher's clone?`,
    );
  // The repository this runs from: the appliance is its folder appliance/.
  const repo = topOf(REPO_DIR);
  const folder = REPO_DIR.slice(repo.length + 1);
  if (!folder)
    throw new Error(
      `${REPO_DIR} is a repository's top: this candidate ships from the Whombat repository's appliance/`,
    );
  await git(repo, 'fetch', '-q', 'origin');
  const ops = opsDir(REPO_DIR);

  // --cloud (ONE-19): control and the relay at one commit of whombat-cloud's main, which its deploy.sh builds from
  // that checkout.
  let cloud: { rev: string; dir: string; deploySh: string } | null = null;
  if (a.cloud) {
    const checkout = cloudCheckout();
    const picked = await resolveCloud(checkout.dir, a.cloud, !a.dryRun);
    cloud = { rev: picked.rev, ...checkout };
  }

  // A run that stopped carries on with its plan, from the commit it was made for.
  let p = a.dryRun ? null : await planToResume(repo, a, cloud?.rev ?? null);
  const resumed = p !== null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const root =
    process.env.WB_CANDIDATE_WORKTREES ??
    (existsSync('/data/t3-worktrees') ? '/data/t3-worktrees/Whombat' : join(TMP_DIR, 'candidate-worktrees'));
  const wt = join(root, `candidate-${stamp}`);
  const startAt = p ? release.releaseCommit(p) : a.dryRun ? 'HEAD' : 'origin/main';
  await git(repo, 'worktree', 'add', '-q', '--detach', wt, startAt);
  const app = join(wt, folder);
  let keepWorktree = true;
  try {
    const install = await run('pnpm', ['install', '--frozen-lockfile', '--offline'], {
      cwd: join(app, 'harness'),
      ...scope('pnpm'),
    });
    if (install.code !== 0) await sh('pnpm', ['install', '--frozen-lockfile'], join(app, 'harness'));

    const all = builds();
    const newest = plan.newestOnBeta(beta);
    let rel: string;

    if (!p) {
      const commit = await git(wt, 'rev-parse', 'HEAD');
      const short = commit.slice(0, 8);
      const version = release.nextVersion(
        knownVersions(ops),
        a.minor ? 'minor' : 'patch',
        a.version,
        release.firstVersion(legacyCandidates(ops)),
      );
      rel = join(TMP_DIR, `rel-${version}`);
      mkdirSync(rel, { recursive: true });
      log = join(rel, 'candidate.log');
      say(
        `candidate ${version} from Whombat ${short}, Beta's newest release ${newest ?? '(none)'}; log ${log}`,
      );

      // 2. The hosted plan.
      const cloudParts = cloud ? await cloudPlan(cloud.deploySh, cloud.rev) : null;
      for (const part of cloudParts ?? [])
        say(`whombat-cloud ${cloud?.rev.slice(0, 7)}: ${part.part} ${part.verdict}: ${part.why}`);
      const web = await webDecision(repo, commit);
      const hosted = plan.hostedPlan({
        cloud: cloud && cloudParts ? { rev: cloud.rev, plan: cloudParts } : null,
        whombatRev: commit,
        web,
        done: [],
      });
      const versions = JSON.parse(await git(wt, 'show', 'HEAD:packages/core/package.json')) as {
        version: string;
      };
      const contracts = versions.version;
      const controlDeploy = cloud && hosted.some((h) => h.part === 'control') ? cloud : null;
      const refused = plan.controlSpeaks({
        needed: contracts,
        control: controlDeploy
          ? plan.vendoredContracts(
              await git(controlDeploy.dir, 'show', `${controlDeploy.rev}:control/package.json`),
            )
          : await liveControlContracts(),
        from: controlDeploy
          ? `whombat-cloud ${controlDeploy.rev.slice(0, 7)}'s control (--cloud)`
          : 'production control',
      });
      if (refused) throw new Error(refused);

      // 3. The box's release. The generated files first: Nix refuses a tree whose fixed hash is stale, and the image
      // carries the agents' signatures, so both are settled (in this worktree, as one commit on top) before the
      // runtime and the image are compared.
      const prep: release.ReleasePlan['prep'] = { hashes: [], sign: false, commit: null };
      const staleRun = await sh(join(app, 'scripts', 'ci', 'fixed-hashes.sh'), ['--stale'], app);
      prep.hashes = staleRun.stdout.split('\n').filter(Boolean);
      if (prep.hashes.length) {
        say(`fixed hashes went stale on main (${prep.hashes.join(', ')}): refreshing them`);
        await sh(join(app, 'scripts', 'ci', 'fixed-hashes.sh'), ['--refresh', ...prep.hashes], app, {
          env: NIX,
          timeoutMs: 40 * 60_000,
        });
      }
      const commitStamp = await stampAt(wt, commit);
      // The tree as it is now: the commit itself, or with the refreshed hashes not yet committed.
      const dirtyFlake = `git+file://${wt}?dir=${folder}`;
      const treeFlake = () => (prep.hashes.length || prep.sign ? dirtyFlake : flakeAt(wt, commit));
      // The refresh read the tree as it was, and what follows reads it with the new hashes.
      if (prep.hashes.length) await sawTree(dirtyFlake);
      const agentsBuilt = await stage('agents', () => checkAgents(app, treeFlake()));
      const agents = release.chooseAgents({ ...agentsBuilt, commit: commitStamp });
      // The first release from here carries the agents servers have, or stops before anything is signed.
      const firstOfAll = knownVersions(ops).length === 0;
      const agentsRefused = release.firstReleaseRefusal({ first: firstOfAll, agents: agents.action });
      if (agentsRefused) throw new Error(agentsRefused);
      const { on: onNewest, host: hostBuild } = plan.betaBuilds(all, newest);
      const hostSource =
        (buildOf(hostBuild?.id ?? null)?.source as { rev?: string } | undefined)?.rev ?? null;
      if (agents.action === 'sign') {
        say(`${agents.why}: they are signed as ${agents.version}`);
        await afterPublished(repo, app, hostSource, agentsBuilt, agents.version, rel);
        prep.sign = true;
        if (a.dryRun) say('dry run: nothing is signed; a real run signs them and makes a host release');
        else
          await stage('sign agents', () =>
            sh(opsCommand(REPO_DIR, 'sign-agents'), ['--rev', commit, '--version', agents.version], app, {
              env: { ...NIX, WHOMBAT_APPLIANCE: app },
              timeoutMs: 40 * 60_000,
            }),
          );
        // The signer built the agents from the tree with the new version in it.
        if (!a.dryRun) await sawTree(dirtyFlake);
      } else await afterPublished(repo, app, hostSource, agentsBuilt, agents.version, rel);

      // The release commit, here only until step 6 pushes it: the generated files on top of the commit.
      let evalRev = commit;
      if ((prep.hashes.length || prep.sign) && !a.dryRun) {
        await git(wt, 'add', '-A', '--', folder);
        const parts = [
          ...(prep.hashes.length ? [`the fixed hashes ${prep.hashes.join(', ')}`] : []),
          ...(prep.sign ? [`the agents' signatures (${agents.version})`] : []),
        ];
        await git(
          wt,
          'commit',
          '-q',
          '-m',
          `release: refresh ${parts.join(' and ')} for candidate ${version}${trailer(a)}`,
        );
        evalRev = await git(wt, 'rev-parse', 'HEAD');
        prep.commit = evalRev;
      }
      const flake = a.dryRun && (prep.hashes.length || prep.sign) ? treeFlake() : flakeAt(wt, evalRev);
      if (a.dryRun && (prep.hashes.length || prep.sign)) await sawTree(dirtyFlake);

      const published = await publishedRuntime(repo, newest);
      const evaluated = published
        ? await stage('runtime', () => runtimeUnder(app, flake, published.stamp))
        : null;
      const runtime = release.chooseRuntime({
        published,
        evaluated,
        inStore: published && evaluated === published.storePath ? await storeHash(published.storePath) : null,
        commit: commitStamp,
      });
      say(`runtime: ${runtime.why}`);

      let compared: { hostRelease: string; equal: boolean } | null = null;
      let incomparable: string | undefined;
      if (!a.host && agents.action !== 'sign') {
        if (!hostBuild || !onNewest)
          incomparable = `Beta's newest release ${newest ?? '(none)'} has no host build here`;
        else
          try {
            // The comparison reads that host release's own commit too.
            if (hostSource)
              try {
                flakeAt(repo, hostSource);
              } catch {
                // nowhere to be found: host-path says so
              }
            const r = await stage('image', () =>
              hostPath(app, join(RELEASES, hostBuild.id, 'build.json'), evalRev),
            );
            compared = { hostRelease: hostBuild.id, equal: r.equal };
          } catch (err) {
            incomparable = `this commit's image couldn't be compared with ${hostBuild.id}'s (${(err as Error).message.slice(0, 200)})`;
          }
      }
      const host = release.chooseHost({ force: a.host, agents: agents.action, compared, incomparable });
      say(`image: ${host.why}`);

      const kind = release.kindOf({
        imageChanged: host.changed,
        runtimeKept: runtime.kept,
        hosted: hosted.length,
      });
      p = {
        v: 1,
        version,
        what: a.what,
        why: a.why,
        commit,
        kind,
        releaseId: release.isRelease(kind)
          ? plan.nextProdId([...all.map((b) => b.id), ...beta], new Date())
          : null,
        runtime,
        agents,
        host,
        contracts,
        cloud: cloud && cloudParts ? { rev: cloud.rev, parts: plan.cloudPinned(cloudParts) } : null,
        web,
        hosted,
        prep,
        done: [],
        at: new Date().toISOString(),
        began: new Date(started).toISOString(),
      };
      say(`plan: ${release.planWords(p)}`);

      // 4. Nothing at all, and the dry run's end.
      if (a.dryRun || kind === 'nothing') {
        say(
          a.dryRun
            ? `dry run: candidate ${version} would be ${release.KIND_WORDS[kind]}${p.releaseId ? ` (${p.releaseId})` : ''}; nothing was built, deployed, published or kept`
            : `nothing to ship: Whombat ${short} changes nothing a box runs since ${newest ?? 'the last release'}, and no hosted part is to deploy`,
        );
        await git(repo, 'worktree', 'remove', '--force', wt);
        keepWorktree = false;
        // Neither keeps a run's folder: a number is a candidate that shipped something.
        await run('rm', ['-rf', rel], { cwd: TMP_DIR });
        return;
      }
      // 5. The plan, before any release is built.
      stepDone(rel, p, 'plan');
    } else {
      rel = join(TMP_DIR, `rel-${p.version}`);
      log = join(rel, 'candidate.log');
      say(`candidate ${p.version}: ${release.planWords(p)}; log ${log}`);
    }
    const running = join(TMP_DIR, 'dev-candidate.running');
    const since = existsSync(running) ? (readFileSync(running, 'utf8').split(',')[0] ?? '').trim() : '';
    writeFileSync(running, `${since || `pid ${process.pid}`}, candidate ${p.version}, log ${log}\n`);
    const done = (step: release.Step) => (p as release.ReleasePlan).done.includes(step);

    // 6. Release prep: the generated files, as one commit on main. Main must still be the commit the plan was made
    // for: anything merged meanwhile was not compared, so the run stops and the next one plans again.
    if (release.needsPrep(p) && !done('prep')) {
      const plan0 = p;
      await stage('release prep', async () => {
        if (!plan0.prep.commit) throw new Error('the plan names no release-prep commit');
        const r = await run('git', ['push', '-q', 'origin', `${plan0.prep.commit}:main`], {
          cwd: wt,
          logFile: log,
          ...scope('git'),
        });
        if (r.code !== 0)
          throw new Error(
            `origin refused the release-prep commit (${r.stderr.trim().split('\n').at(-1) ?? ''}): main moved since ${plan0.commit.slice(0, 8)}; run the candidate again, it plans from the new main`,
          );
        // The signed agents at the clean release commit, the strict check a release needs.
        if (plan0.prep.sign)
          await sh(
            'nix',
            [
              'build',
              '--no-link',
              `${flakeAt(wt, plan0.prep.commit)}#checks.x86_64-linux.hosts-agent-manifest`,
            ],
            app,
            {
              env: NIX,
              timeoutMs: 40 * 60_000,
            },
          );
        await fastForward(repo);
      });
      stepDone(rel, p, 'prep');
    }
    const releaseRev = release.releaseCommit(p);

    // 7. The release build, with the plan's choices.
    let built: { releaseId: string; dir: string } | null = null;
    if (release.isRelease(p.kind)) {
      const id = p.releaseId as string;
      const dir = join(RELEASES, id);
      if (!done('build')) {
        const plan0 = p;
        await stage('release build', async () => {
          const b = buildOf(id) as { source?: { rev?: string }; chain?: unknown } | null;
          if (b?.source?.rev === releaseRev && b.chain) return;
          // `release/ship build` reads the release commit's flake from a worktree of its own: the same copy.
          flakeAt(wt, releaseRev);
          await sh(
            join(app, 'release', 'ship'),
            [
              'build',
              id,
              '--runtime-stamp',
              release.stampArg(plan0.runtime.stamp),
              '--candidate',
              plan0.version,
              ...(plan0.host.reuse ? ['--reuse-host', plan0.host.reuse] : ['--host']),
              ...(process.env.WB_CANDIDATE_NO_NEWER_CHECK === '1' ? ['--no-newer-check'] : []),
            ],
            app,
            { timeoutMs: 60 * 60_000, logFile: join(rel, 'build.log') },
          );
        });
        const b = buildOf(id) as {
          class?: string;
          source?: { rev?: string };
          tuple?: { runtime?: { storePath?: string } };
        } | null;
        if (b?.source?.rev !== releaseRev)
          throw new Error(`${id} was not built from ${releaseRev.slice(0, 12)}`);
        if (!p.host.reuse && b.class !== 'host')
          throw new Error(`${id} is a ${b.class ?? '?'} release, not a host release`);
        if (p.runtime.kept && p.runtime.from) {
          const kept = (buildOf(p.runtime.from) as { tuple?: { runtime?: { storePath?: string } } } | null)
            ?.tuple?.runtime?.storePath;
          if (kept !== b.tuple?.runtime?.storePath)
            throw new Error(`${id} was to keep the runtime of ${p.runtime.from}, but built another one`);
        }
        // The first release from here adds no database change: checked on what was built, before anything goes out.
        const writesOf = (x: unknown) =>
          (x as { tuple?: { runtime?: { schemaWrites?: number } } } | null)?.tuple?.runtime?.schemaWrites ??
          null;
        const schemaRefused = release.firstReleaseRefusal({
          first: knownVersions(ops).length === 0,
          schema: { writes: writesOf(b), lastWrites: writesOf(buildOf(newest)), last: newest },
        });
        if (schemaRefused) throw new Error(`${id} is built but stays unpublished: ${schemaRefused}`);
        stepDone(rel, p, 'build');
      }
      built = { releaseId: id, dir };
    }

    // 8. The hosted parts (control before the account site, P's order): a Beta box that takes the release finds
    // production speaking it.
    const liveSpeaks = async (before: string) => {
      const why = plan.controlSpeaks({
        needed: (p as release.ReleasePlan).contracts,
        control: await liveControlContracts(),
        from: `production control (live, before ${before})`,
      });
      if (why) throw new Error(why);
    };
    if (p.hosted.length && !done('hosted')) {
      for (const h of p.hosted) {
        if (hostedDone(rel).some((d) => d.part === h.part && d.ref === h.ref)) continue;
        if (h.part === 'web' || h.part === 'embed') await liveSpeaks(`the ${h.part}`);
        // Control and the relay with the script of the checkout they are built from; the rest with WB_DEPLOY_SH's.
        const deploySh =
          cloud && (h.part === 'control' || h.part === 'relay')
            ? cloud.deploySh
            : shipContext().prod.deploySh;
        await unfrozenStage(a, `production: ${h.part}`, () => deployHosted(rel, h, deploySh));
      }
      stepDone(rel, p, 'hosted');
    }

    // 9. Beta (ONE-03, ONE-19). Run again, it finishes what is there (ghpublish).
    if (built && !done('beta')) {
      const release0 = built;
      await liveSpeaks('Beta');
      await unfrozenStage(a, 'beta', async () => {
        // Without WB_TUFREPO the publisher is built from the checkout this runs from, as it is: one more copy.
        const tufrepo = await tufrepoBin();
        if (!process.env.WB_TUFREPO) await sawTree(checkoutFlake(REPO_DIR));
        const r = await run(tufrepo, plan.githubPublishArgs(github.dir, join(release0.dir, 'release')), {
          cwd: app,
          logFile: join(rel, 'github.log'),
        });
        if (r.code !== 0)
          throw new Error(
            `Beta didn't take ${release0.releaseId} (${join(rel, 'github.log')}); run the candidate again once the cause is fixed`,
          );
        writeFileSync(
          join(rel, 'published.json'),
          `${JSON.stringify({ release: release0.releaseId, channel: 'development', at: new Date().toISOString() }, null, 2)}\n`,
        );
        say(`${release0.releaseId} is in Beta`);
      });
      stepDone(rel, p, 'beta');
    }

    // 10. The record and the runbook's section, in whombat-ops.
    const total = Date.now() - started;
    const deployed = hostedDone(rel);
    const runtimeVersion =
      (buildOf(p.releaseId) as { tuple?: { runtime?: { version?: string } } } | null)?.tuple?.runtime
        ?.version ?? null;
    const record = release.recordOf(p, { runtimeVersion, hosted: deployed, at: new Date().toISOString() });
    if (!done('record')) {
      const plan0 = p;
      await stage('record', async () => {
        if (!ops) {
          say(
            'no whombat-ops on this machine: this release gets no record and no section in the releases runbook',
          );
          return;
        }
        await commitRunbook({
          ops,
          message: `records: candidate ${plan0.version}${plan0.releaseId ? `, ${plan0.releaseId} in Beta` : ''}${deployed.length ? `, ${deployed.map((h) => h.part).join(', ')} on production` : ''}${trailer(a)}`,
          change: (text) =>
            plan.appendSection(
              text || `${plan.RELEASES_RUNBOOK_HEAD}\n`,
              runbookSection(record, mins(total)),
            ),
          also: { [`records/releases/${plan0.version}.json`]: () => `${JSON.stringify(record, null, 2)}\n` },
          say,
        });
      });
      stepDone(rel, p, 'record');
    }

    writeFileSync(
      join(rel, 'summary.json'),
      `${JSON.stringify({ ...record, seconds: Object.fromEntries(times.map(([n, ms]) => [n, Math.round(ms / 1000)])), totalS: Math.round(total / 1000), resumed }, null, 2)}\n`,
    );
    await git(repo, 'worktree', 'remove', '--force', wt);
    keepWorktree = false;
    process.stdout.write(
      [
        `Candidate ${p.version}: ${p.releaseId ? `${p.releaseId} is in ${plan.TAKEN_BY}` : 'no release for boxes'}; in ${mins(total)}.`,
        `  ${release.planWords(p)}`,
        `  ${plan.hostedWords(deployed)}`,
        ...(p.releaseId ? [`  Production: promote ${p.releaseId} --yes, on John's word`] : []),
        `  ${times.map(([n, ms]) => `${n} ${mins(ms)}`).join(' · ')}`,
        '',
      ].join('\n'),
    );
  } finally {
    if (keepWorktree)
      say(`the worktree stays at ${wt} for a look (git worktree remove --force ${wt} when done)`);
    // A run that carries on began when the run that made its plan did, and the copies of its commits are its own
    // even when this part of it read none of them (only the deploys and the publish were left to do).
    if (p) {
      revsRead.add(p.commit);
      revsRead.add(release.releaseCommit(p));
    }
    await dropSourceCopies(repo, p ? Math.min(started, Date.parse(p.began ?? p.at) || started) : started);
  }
}

/**
 * `candidate --legacy-version`: the number a release by the old flow takes after releases moved here, the next patch
 * of the old flow's own minor (`release.legacyVersion`). It counts the old flow's manifests where they are now, the
 * ones a later run of it wrote in the appliance's old repository, and the runs' folders.
 */
export function legacyVersionNow(ops: string | null): string {
  const names = (dir: string, re: RegExp) =>
    existsSync(dir)
      ? readdirSync(dir)
          .map((f) => re.exec(f)?.[1])
          .filter((v): v is string => !!v)
      : [];
  return release.legacyVersion(legacyCandidates(ops), [
    ...archives().flatMap((a) => names(join(a, 'manifest', 'candidates'), /^(\d+\.\d+\.\d+)\.json$/)),
    ...names(TMP_DIR, /^rel-(\d+\.\d+\.\d+)$/),
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.slice(2).some((o) => o === '-h' || o === '--help')) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (process.argv.slice(2).includes('--legacy-version')) {
    try {
      process.stdout.write(`${legacyVersionNow(opsDir(REPO_DIR))}\n`);
      process.exit(0);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }
  main().catch((e: unknown) => {
    say(`stopped at “${current}”: ${e instanceof Error ? e.message : String(e)}`);
    say(`log: ${log}`);
    process.exit(1);
  });
}
