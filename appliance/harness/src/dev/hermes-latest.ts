/**
 * `appliance/release-tools/hermes/latest-tested [--dry-run] [--retry-failed] [--version x.y.z] [--whombat-ref <rev>]
 * [--no-candidate]` — the latest-tested Hermes job (Whombat HU-03, HU-06; NX-485; docs/runbooks/hermes-latest-tested.md),
 * modelled on the Claude Code one (release-tools/clients/latest-tested). Hermes is pinned in two places of the one
 * repository, which must agree: the runtime's `packages/agent-runtime/src/hermes/pin.ts` and the appliance's
 * `flake.nix` and `nix/packages/hermes`. The job moves both in one commit. One run:
 *
 *   1. Detect: Hermes's newest stable release on GitHub (published, not a pre-release, a `vX.Y.Z` tag: never `+canary`
 *      or a calendar tag) against the pins on origin/main. Nothing newer, or both already there: done. A version that
 *      failed before is skipped until `--retry-failed`.
 *   1b. Review (NX-492): with `WB_HERMES_REVIEW` set, a new version found by the daily run isn't tested yet: the job
 *      leaves it for review (`markers/hermes-<version>.review`, the release as JSON) and ends. The T3 Code task “Hermes
 *      Agent release review” finds it there each morning; its agent reads the release against Whombat's use of Hermes,
 *      makes what has to change on a branch and runs this job with `--version` and the branch
 *      (docs/runbooks/hermes-review.md). Nobody reviewed it in two days: the job tests it as it is. `--version` never
 *      waits for a review.
 *   2. Move the pin in a scratch worktree of origin/main (or of `--whombat-ref`, a review's branch): pin.ts (version,
 *      tag, commit); in `appliance/` the `hermes` flake input, the uv2nix inputs at the revisions that release's own
 *      flake.lock names, and the package's `version`/`pinnedRev`, then `nix flake update` of those four (NX-433). One
 *      commit.
 *   3. Test, simply (NX-490): install it and see it still works. The appliance's flake of that commit:
 *      `.#whombat-hermes` (the build, and its install check: the activation's Hermes check, which starts it with
 *      Whombat's plugin and providers and opens an ACP session), `checks.hermes` (the pin agreement) and the
 *      `runtime-live-turn` VM test (the runtime on a box, one turn), run inside `agent-resource run`. The plugin's own
 *      tests are not a gate: they follow Hermes's internals and run in CI on Hermes's newest release. Any failure:
 *      nothing is committed or shipped, the version's failed marker stops retries, and its log says why.
 *   4. On a pass: the pin commit onto origin/main, fast-forward only (onto a main that moved meanwhile only when it
 *      didn't touch what the test covered; else the next run tests again; a branch only when it still has its main in
 *      it, else it is rebased and tested again), pushed through the checkout's guarded hooks while whombat-ops
 *      `candidate` is held off (its lock). The local checkout, on a clean `main`, is fast-forwarded. `--dry-run` stops
 *      here with `git push --dry-run`, which shows the push would go through.
 *   5. whombat-ops `candidate --what "hermes agent X" --why "…"`: Beta only (HU-06: the box's “Updated to …” names
 *      it; ONE-19). Never Production: that stays `promote`, on John's word.
 *
 * Settings (environment, e.g. ~/.config/whombat/hermes-latest-tested.env): WB_HERMES_WHOMBAT (~/Code/Whombat: its
 * worktrees, its push and its candidate), WB_HERMES_STATE (~/.local/state/whombat-hermes: logs/, markers/, work/),
 * WB_HERMES_UPSTREAM (NousResearch/hermes-agent), GITHUB_TOKEN (else `gh auth token`), WB_HERMES_REVIEW (empty: no
 * review, the job tests at once). The wrapper holds $WB_HERMES_STATE/job.lock: two runs never overlap.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { opsCommand } from '../lib/guards.ts';
import { expandHome, REPO_DIR, TMP_DIR } from '../lib/paths.ts';
import { must, type RunOptions, run } from '../lib/proc.ts';
import * as cand from './candidate-plan.ts';
import * as plan from './hermes-latest-plan.ts';

const HOME = homedir();
const STATE =
  process.env.WB_HERMES_STATE ??
  join(process.env.XDG_STATE_HOME ?? join(HOME, '.local', 'state'), 'whombat-hermes');
const WHOMBAT = expandHome(process.env.WB_HERMES_WHOMBAT ?? '~/Code/Whombat');
const UPSTREAM = process.env.WB_HERMES_UPSTREAM ?? 'NousResearch/hermes-agent';
/** The appliance's folder in the repository, where its flake is. */
const FOLDER = 'appliance';
const PIN_TS = 'packages/agent-runtime/src/hermes/pin.ts';
const FLAKE_NIX = `${FOLDER}/flake.nix`;
const HERMES_NIX = `${FOLDER}/nix/packages/hermes/default.nix`;
const RUNTIME_NIX = `${FOLDER}/nix/packages/runtime/default.nix`;
const NIX = {
  NIX_CONFIG: `${process.env.NIX_CONFIG ?? ''}\nextra-experimental-features = nix-command flakes`,
};
const SYSTEM = 'x86_64-linux';

interface Args {
  dryRun: boolean;
  retryFailed: boolean;
  version: string | null;
  candidate: boolean;
  /** `--whombat-ref`: this commit instead of origin/main (a review's branch, NX-492; a change to the job). */
  whombatRef: string | null;
}

const USAGE =
  'usage: appliance/release-tools/hermes/latest-tested [--dry-run] [--retry-failed] [--version x.y.z] [--whombat-ref <rev>] [--no-candidate]';

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { dryRun: false, retryFailed: false, version: null, candidate: true, whombatRef: null };
  for (let i = 0; i < argv.length; i++) {
    const o = argv[i];
    if (o === '--dry-run') a.dryRun = true;
    else if (o === '--retry-failed') a.retryFailed = true;
    else if (o === '--no-candidate') a.candidate = false;
    else if (o === '--appliance-ref')
      throw new Error(
        `the appliance is part of Whombat now: its change goes on the same branch, --whombat-ref\n${USAGE}`,
      );
    else if (o === '--whombat-ref') {
      const rev = argv[++i] ?? null;
      if (!rev) throw new Error(`${o} takes a commit\n${USAGE}`);
      a.whombatRef = rev;
    } else if (o === '--version') {
      const v = argv[++i];
      if (!v || !plan.stableVersion(`v${v.replace(/^v/, '')}`))
        throw new Error(`--version takes x.y.z\n${USAGE}`);
      a.version = v.replace(/^v/, '');
    } else throw new Error(`unknown argument ${o}\n${USAGE}`);
  }
  if (a.whombatRef && !a.version)
    throw new Error(`--whombat-ref tests one release: give its --version\n${USAGE}`);
  return a;
}

let log = '';
const say = (text: string) => {
  const line = `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} hermes-latest: ${text}`;
  console.log(line);
  if (log) writeFileSync(log, `${line}\n`, { flag: 'a' });
};
const scope = (cmd: string): Partial<RunOptions> => {
  const memoryHigh = cand.memoryHighFor(cmd);
  return memoryHigh ? { memoryHigh } : {};
};
const sh = (cmd: string, args: readonly string[], cwd: string, o: Partial<RunOptions> = {}) =>
  must(cmd, args, { cwd, logFile: log || undefined, timeoutMs: 30 * 60_000, ...scope(cmd), ...o });
const git = async (cwd: string, ...args: string[]) => (await sh('git', args, cwd)).stdout.trim();
const ok = async (cmd: string, args: readonly string[], cwd: string, o: Partial<RunOptions> = {}) =>
  (await run(cmd, args, { cwd, logFile: log || undefined, timeoutMs: 5 * 60_000, ...scope(cmd), ...o }))
    .code === 0;

/** A failure of the release under test (a failed marker), not of the job's own surroundings (retried next run). */
class TestFailed extends Error {}
const tested = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
  say(`test: ${step}`);
  try {
    return await fn();
  } catch (err) {
    throw new TestFailed(`${step}: ${(err as Error).message}`);
  }
};

async function githubToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = await run('gh', ['auth', 'token'], { cwd: HOME, timeoutMs: 30_000 }).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() || null : null;
}

async function releases(): Promise<plan.GithubRelease[]> {
  const token = await githubToken();
  const res = await fetch(`https://api.github.com/repos/${UPSTREAM}/releases?per_page=50`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'whombat-hermes-latest-tested',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`GitHub's releases of ${UPSTREAM}: HTTP ${res.status}`);
  return (await res.json()) as plan.GithubRelease[];
}

/** The commit a tag names (the peeled commit of an annotated tag). */
async function tagCommit(tag: string): Promise<string> {
  const out = await git(
    HOME,
    'ls-remote',
    `https://github.com/${UPSTREAM}.git`,
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  );
  const lines = out.split('\n').map((l) => l.split('\t'));
  const sha = (lines.find((l) => l[1]?.endsWith('^{}')) ?? lines[0])?.[0];
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`no commit for ${UPSTREAM} ${tag}`);
  return sha;
}

async function hermesFlakeLock(commit: string): Promise<string> {
  const res = await fetch(`https://raw.githubusercontent.com/${UPSTREAM}/${commit}/flake.lock`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Hermes's flake.lock at ${commit.slice(0, 8)}: HTTP ${res.status}`);
  return res.text();
}

const marker = (version: string, kind: 'failed' | 'ok' | 'shipped' | 'candidate-failed' | 'review') =>
  join(STATE, 'markers', `hermes-${version}.${kind}`);

/** A worktree of `repo` at `rev` in `dir` (detached), replacing what a previous run left. */
async function worktree(repo: string, dir: string, rev: string): Promise<void> {
  if (existsSync(dir)) await ok('git', ['worktree', 'remove', '--force', dir], repo);
  rmSync(dir, { recursive: true, force: true });
  await ok('git', ['worktree', 'prune'], repo);
  await git(repo, 'worktree', 'add', '-q', '--detach', dir, rev);
}

/** A commit of what changed in `dir` (the job's; nothing when nothing changed). Its hash. */
async function commitAll(dir: string, message: string): Promise<string | null> {
  await git(dir, 'add', '-A');
  if (await ok('git', ['diff', '--cached', '--quiet'], dir)) return null;
  await git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * The tested pin commit `pinned` (on `base`) onto `repo`'s origin/main now: itself when main didn't move; picked onto
 * the new main when nothing the test covered changed there; null when it did (the next run tests again).
 */
async function ontoMain(
  dir: string,
  base: string,
  pinned: string,
  covered: readonly string[],
  branch: boolean,
): Promise<string | null> {
  await git(dir, 'fetch', '-q', 'origin', 'main');
  const head = await git(dir, 'rev-parse', 'origin/main');
  if (head === base) return pinned;
  // A review's branch goes on only as it was tested, on top of its main: a main that moved past it needs a rebase.
  if (branch) return (await ok('git', ['merge-base', '--is-ancestor', head, base], dir)) ? pinned : null;
  const changed = (await git(dir, 'diff', '--name-only', base, head)).split('\n').filter(Boolean);
  if (!plan.movedOutsideTest(changed, covered)) return null;
  await git(dir, 'switch', '-q', '--detach', head);
  if (!(await ok('git', ['cherry-pick', pinned], dir))) {
    await ok('git', ['cherry-pick', '--abort'], dir);
    return null;
  }
  return git(dir, 'rev-parse', 'HEAD');
}

/** Fast-forwards a person's checkout to origin/main only when it is on a clean `main`; says what it did. */
async function fastForward(repo: string): Promise<void> {
  const branch = (await run('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: repo })).stdout.trim();
  const dirty = (
    await run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo })
  ).stdout.trim();
  if (branch === 'main' && !dirty && (await ok('git', ['merge', '--ff-only', '-q', 'origin/main'], repo)))
    say(`${repo} fast-forwarded to origin/main`);
  else
    say(
      `${repo} left as it is (${branch || 'detached'}${dirty ? ', with changes' : ''}); origin/main has the pin`,
    );
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  for (const d of ['logs', 'markers', 'work']) mkdirSync(join(STATE, d), { recursive: true });

  // 1. Detect.
  await git(WHOMBAT, 'fetch', '-q', 'origin', 'main');
  const main = await git(WHOMBAT, 'rev-parse', 'origin/main');
  const base = a.whombatRef ? await git(WHOMBAT, 'rev-parse', '--verify', `${a.whombatRef}^{commit}`) : main;
  // What is pinned is what main says; a branch only carries the change for the new one.
  const wPin = plan.readPinTs(await git(WHOMBAT, 'show', `${main}:${PIN_TS}`));
  const aPin = plan.readHermesPackage(await git(WHOMBAT, 'show', `${main}:${HERMES_NIX}`));
  const all = await releases();
  const target = a.version
    ? all.find((r) => !r.draft && !r.prerelease && plan.stableVersion(r.tag_name) === a.version)
    : null;
  if (a.version && !target)
    throw new Error(`Hermes ${a.version} is no stable release of ${UPSTREAM} on GitHub`);
  const newest = target ? { tag: target.tag_name, version: a.version as string } : plan.newestStable(all);
  if (!newest) throw new Error(`GitHub names no stable release of ${UPSTREAM}`);
  const { tag, version } = newest;
  // `--version` of the pin itself tests it again (a rehearsal of the job): nothing to pin or ship afterwards.
  const branch = Boolean(a.whombatRef);
  const pinnedBoth = wPin.version === version && aPin.version === version && !branch;
  if (pinnedBoth && !a.version) {
    say(`Hermes ${version} is pinned in the runtime and the appliance: nothing to test`);
    return 0;
  }
  if (!a.version && plan.compareSemver(version, wPin.version) < 0) {
    say(
      `Hermes's newest stable release is ${version}, older than Whombat's pin ${wPin.version}: nothing to test`,
    );
    return 0;
  }
  // A review's branch is a new attempt at a version that failed before.
  if (existsSync(marker(version, 'failed')) && !a.retryFailed && !branch) {
    say(
      `Hermes ${version} failed before (${readFileSync(marker(version, 'failed'), 'utf8').trim()}): skipped until --retry-failed`,
    );
    return 0;
  }
  if ((process.env.WB_HERMES_REVIEW ?? '').trim() && !a.version && !a.dryRun) {
    const asked = marker(version, 'review');
    const step = plan.reviewStep(existsSync(asked) ? statSync(asked).mtimeMs : null, Date.now());
    if (step === 'ask') {
      const request = {
        ...plan.reviewRequest(version, tag, wPin.version, UPSTREAM),
        asked: new Date().toISOString(),
      };
      writeFileSync(asked, `${JSON.stringify(request)}\n`);
      say(`Hermes ${version} (${tag}) is new: left for its review, which tests it with this job`);
      return 0;
    }
    if (step === 'wait') {
      say(`Hermes ${version} waits for its review (${asked})`);
      return 0;
    }
    say(`Hermes ${version} wasn't reviewed in two days: it is tested as it is`);
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  log = join(STATE, 'logs', `hermes-${version}-${stamp}.log`);
  say(
    `Hermes ${version} (${tag}); main pins ${wPin.version} in the runtime, ${aPin.version} in the appliance; testing on ${base.slice(0, 10)}; log ${log}`,
  );
  const commit = await tagCommit(tag);
  const uv = plan.uv2nixRevs(await hermesFlakeLock(commit));
  const pin: plan.HermesPin = { version, tag, commit };

  const work = join(STATE, 'work', version);
  const wt = join(work, 'whombat');
  mkdirSync(work, { recursive: true });
  let failed: string | null = null;
  try {
    // 2. The pin, in both places, in one commit of a scratch worktree.
    await worktree(WHOMBAT, wt, base);
    const pinFile = join(wt, PIN_TS);
    writeFileSync(pinFile, plan.setPinTs(readFileSync(pinFile, 'utf8'), pin));
    const flakeFile = join(wt, FLAKE_NIX);
    writeFileSync(
      flakeFile,
      plan.setFlakeUv2nix(plan.setFlakeHermes(readFileSync(flakeFile, 'utf8'), commit, tag), uv),
    );
    const pkgFile = join(wt, HERMES_NIX);
    writeFileSync(pkgFile, plan.setHermesPackage(readFileSync(pkgFile, 'utf8'), version, commit));
    await sh('nix', ['flake', 'update', 'hermes', ...Object.keys(plan.UV2NIX_INPUTS)], join(wt, FOLDER), {
      env: NIX,
    });
    const pinned =
      (await commitAll(wt, `hermes: Hermes Agent ${version}, tested by the latest-tested Hermes job`)) ??
      base;

    // 3. The tests, on the appliance's flake of that worktree.
    const flake = `git+file://${wt}?dir=${FOLDER}`;
    const nixOpts = { env: NIX, timeoutMs: 120 * 60_000 };
    // The runtime's pnpm store hash on main follows its lockfile (the candidate refreshes one that slipped). One that
    // doesn't is put right for this test only, in the worktree: it is no fault of the Hermes under test.
    {
      const r = await run('nix', ['build', '--no-link', '-L', `${flake}#whombat-runtime.pnpmDeps`], {
        cwd: wt,
        logFile: log,
        ...nixOpts,
        ...scope('nix'),
      });
      if (r.code !== 0) {
        const hash = cand.reportedHash(`${r.stdout}\n${r.stderr}`);
        if (!hash) throw new Error(`the runtime's pnpm store didn't build (log ${log})`);
        const runtimeFile = join(wt, RUNTIME_NIX);
        writeFileSync(runtimeFile, cand.setPnpmDepsHash(readFileSync(runtimeFile, 'utf8'), hash));
        say(`the runtime's pnpm store hash is stale on this commit: ${hash} for the test only`);
      }
    }
    await tested('.#whombat-hermes (its install check and the activation check)', () =>
      sh('nix', ['build', '--no-link', '-L', `${flake}#whombat-hermes`], wt, nixOpts),
    );
    await tested('checks.hermes', () =>
      sh('nix', ['build', '--no-link', '-L', `${flake}#checks.${SYSTEM}.hermes`], wt, nixOpts),
    );
    const driver = await tested(
      "runtime-live-turn's driver",
      async () =>
        (
          await sh(
            'nix',
            [
              'build',
              '--no-link',
              '--print-out-paths',
              '-L',
              `${flake}#checks.${SYSTEM}.runtime-live-turn.driver`,
            ],
            wt,
            nixOpts,
          )
        ).stdout
          .trim()
          .split('\n')
          .at(-1) as string,
    );
    const vmLog = join(STATE, 'logs', `hermes-${version}-${stamp}-runtime-live-turn.log`);
    await tested(`runtime-live-turn (VM; ${vmLog})`, () =>
      sh(
        'agent-resource',
        [
          'run',
          '--task',
          `Hermes ${version} latest-tested: runtime-live-turn`,
          '--ttl',
          '2h',
          '--',
          join(REPO_DIR, 'release-tools', 'hermes', 'run-vm-test'),
          driver,
          vmLog,
        ],
        join(wt, FOLDER),
        { timeoutMs: 125 * 60_000 },
      ),
    );
    // It passed: an earlier failure of this version no longer stops the next run.
    rmSync(marker(version, 'failed'), { force: true });
    if (pinnedBoth) {
      say(`Hermes ${version} passed; it is pinned on main already: nothing to pin or ship`);
      return 0;
    }

    // 4. Onto main, fast-forward only, with the candidate held off.
    await git(wt, 'checkout', '-q', '--', RUNTIME_NIX);
    const onto = await ontoMain(wt, base, pinned, plan.COVERED, branch);
    if (!onto) {
      say(
        branch
          ? `Hermes ${version} passed, but main moved past the branch: nothing pushed; rebase the branch onto origin/main and run again`
          : `Hermes ${version} passed, but main changed what the test covered meanwhile: nothing pushed; the next run tests again`,
      );
      return 1;
    }
    if (a.dryRun) {
      // The push as it would go, through the checkout's hooks (the guard list), changing nothing.
      const tried = await run('git', ['push', '--dry-run', 'origin', `${onto}:refs/heads/main`], {
        cwd: wt,
        logFile: log,
        timeoutMs: 5 * 60_000,
      });
      const shown = (await git(wt, 'show', '--stat', '--format=%h %s', onto)).split('\n');
      for (const line of shown) say(`  ${line}`);
      say(
        tried.code === 0
          ? `Hermes ${version} passed; --dry-run: the push of ${onto.slice(0, 10)} onto main would go through; nothing pushed or shipped`
          : `Hermes ${version} passed; --dry-run: the push onto main would be refused (${`${tried.stderr}`.trim().split('\n').at(-1)})`,
      );
      return tried.code === 0 ? 0 : 1;
    }
    if (onto !== base) {
      const lock = join(process.env.TMPDIR ?? TMP_DIR, 'dev-candidate.lock');
      const pushed = await run(
        'flock',
        ['-w', '7200', lock, 'git', '-C', wt, 'push', '-q', 'origin', `${onto}:refs/heads/main`],
        { cwd: work, logFile: log, timeoutMs: 125 * 60_000 },
      );
      if (pushed.code !== 0)
        throw new Error(
          `pushing the pin failed (${`${pushed.stderr}`.trim().split('\n').at(-1)}): the next run tests again`,
        );
    }
    say(`Hermes ${version} is pinned on main: ${onto.slice(0, 10)}`);
    writeFileSync(marker(version, 'ok'), `${new Date().toISOString()} whombat ${onto}\n`);
    await fastForward(WHOMBAT);

    // 5. Beta (ONE-19).
    if (!a.candidate) {
      say('--no-candidate: candidate not run');
      return 0;
    }
    const words = plan.candidateWords(version);
    say(`candidate --what "${words.what}" --why "${words.why}"`);
    const c = await run(opsCommand(WHOMBAT, 'candidate'), ['--what', words.what, '--why', words.why], {
      cwd: WHOMBAT,
      // The candidate ships the checkout's own appliance folder.
      env: { WHOMBAT_APPLIANCE: undefined },
      logFile: log,
      timeoutMs: 180 * 60_000,
    });
    if (c.code !== 0) {
      writeFileSync(marker(version, 'candidate-failed'), `${new Date().toISOString()} exit ${c.code}\n`);
      say(
        `candidate failed (exit ${c.code}): the pin is on main; ship it with candidate when its cause is fixed`,
      );
      return 1;
    }
    writeFileSync(marker(version, 'shipped'), `${new Date().toISOString()}\n`);
    say(`Hermes ${version} is in Beta`);
    return 0;
  } catch (err) {
    if (err instanceof TestFailed) failed = err.message;
    throw err;
  } finally {
    if (failed) {
      writeFileSync(marker(version, 'failed'), `${new Date().toISOString()} ${failed.split('\n')[0]}\n`);
      say(`Hermes ${version} failed: ${failed.split('\n')[0]}; nothing committed or shipped (log ${log})`);
    }
    if (existsSync(wt)) await ok('git', ['worktree', 'remove', '--force', wt], WHOMBAT);
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err: Error) => {
      say(err.message);
      process.exit(1);
    },
  );
}
