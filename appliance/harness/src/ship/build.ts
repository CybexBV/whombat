/**
 * `release/ship build <id> --runtime-stamp <rev>:<time>:<date> [--candidate <number>]` (UP-C1, UP-A3, UP-C3; IN-94,
 * IN-96, IN-97; ONE-02): from a clean commit of the Whombat repository, with its versions and signed agents checked
 * and the versions checked newer than what the Beta channel publishes, builds the release of the one Whombat image
 * with `release/build prod` (under the heavy lock) and writes the notes and the first record (`build.json`'s `ship`
 * and `chain`). The runtime's stamp is the commit the bundle says it is: whoever makes the release chooses it (the
 * published runtime's to keep that runtime, this commit's for a new one; dev/release-plan.ts) and this passes it on. There is one environment (ONE-01): no DEV twin, no DEV repository; the release goes to Beta
 * (`tufrepo gh-publish`, whombat-ops `candidate`) and to Production only by `promote` (ONE-19).
 *
 * Without `--reuse-host` it decides itself whether only the runtime changed (UP-X16, IN-156): `release/build
 * host-path` evaluates this commit's host as the newest Beta release's host was built; the same store path makes it a
 * runtime-only release on that host, anything else a host release (`--host` forces one). A Beta release of the DEV
 * image (a `whombat-dev-` twin from before ONE-02) is never reused. Releases carry closure indexes only (IN-414). No
 * ISO (UP-X15). The decision and why go into build.json (`ship.host`) and the notes (`delivery`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStamp, type Stamp, stampArg } from '../dev/release-plan.ts';
import { expandHome } from '../lib/paths.ts';
import { run } from '../lib/proc.ts';
import { applianceIn, findSource } from '../lib/source.ts';
import {
  buildScript,
  channelReleaseIds,
  flakeAt,
  git,
  heavy,
  nixBuild,
  nixEval,
  type ShipContext,
  say,
  tufrepo,
} from './context.ts';
import { compareIds, newestBefore, newProdId, parseReleaseId } from './ids.ts';
import { type BuildRecord, gatherNotes, renderMarkdown } from './notes.ts';
import { type ChainedRecord, nextChain, sha256Hex, writeRecord } from './records.ts';

export interface BuildArgs {
  prodId: string;
  reuseHost: string | null;
  /** A host release even when only the runtime changed (UP-X16). */
  forceHost: boolean;
  knownIssues: string[];
  newerCheck: boolean;
  previous: string | null;
  /** `<rev>:<time>:<date>`: the commit the runtime bundle says it is. A build needs one. */
  runtimeStamp: string | null;
  /** The candidate's number, for the records (`--candidate`). */
  candidate: string | null;
}

export interface ShipBuildFacts {
  v: 1;
  /** Always false since ONE-01 (there is no DEV twin to build alone); kept for the records' readers. */
  devOnly: false;
  /** No DEV twin since ONE-01. */
  twin: null;
  /**
   * The candidate this release is. From the one repository: its number, no file (its record is the maintainers'),
   * and the commit of the runtime's stamp. Before, the candidate manifest the image's runtime package named.
   */
  candidate: { name: string; file: string; productVersion: string; whombatRev: string };
  /** The runtime's stamp the release was built with (builds from the one repository). */
  runtimeStamp?: Stamp;
  /** The app's version at the commit (builds from the one repository; before, the candidate's pins named it). */
  app?: string;
  /** `tufrepo check-newer --channel development` against the published Beta channel (ONE-04). */
  newerCheck: { channel: 'development'; ok: boolean; detail: string } | { skipped: string };
  storePaths: { runtime: string; manager: string; equal: true };
  /** The contracts release the runtime vendors: release records name it (`builtFrom.contracts`, IN-420). */
  contracts: string;
  knownIssues: string[];
  notes: { sha256: string; summary: string };
  previous: string | null;
  /** Host or runtime-only, and why (UP-X16). */
  host: HostDecision;
  logs: string[];
}

/** What a commit of the Whombat repository is built with: the contracts' version and the app's. */
export async function versionsAt(top: string, rev: string): Promise<{ contracts: string; app: string }> {
  const version = async (path: string) => {
    const r = await run('git', ['show', `${rev}:${path}`], { cwd: top });
    const v = r.code === 0 ? (JSON.parse(r.stdout) as { version?: string }).version : undefined;
    if (!v || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v))
      throw new Error(`${rev.slice(0, 12)}:${path} names no version: a release record must name it (IN-420)`);
    return v;
  };
  return {
    contracts: await version('packages/core/package.json'),
    app: await version('apps/web/package.json'),
  };
}

interface Evaluated {
  runtime: { version: string; outPath: string };
  manager: { version: string; outPath: string };
  toplevel: string;
  hostAbi: number;
}

async function evaluate(
  repo: string,
  rev: string,
  env: 'prod' | 'dev',
  id: string,
  includeHost: boolean,
  stamp: Stamp,
): Promise<Evaluated> {
  const lib = `(builtins.getFlake "${flakeAt(repo, rev)}").lib`;
  const rel = `(${lib}.applianceRelease { env = "${env}"; releaseId = "${id}"; runtimeStamp = { rev = "${stamp.rev}"; time = ${stamp.time}; date = "${stamp.date}"; }; })`;
  // `path`, not `outPath`: toJSON turns an attribute set with an outPath into that string.
  // A reused host comes from its build record. Forcing a new system's toplevel here evaluates all of NixOS even
  // though that system will never be built or shipped.
  const raw = await nixEval(
    `let r = ${rel}; in { runtime = { version = r.runtime.version; path = r.runtime.outPath; }; manager = { version = r.manager.version; path = r.manager.outPath; }; ${includeHost ? 'toplevel = r.toplevel.outPath;' : ''} hostAbi = r.hostAbi; }`,
    repo,
    true,
  );
  const j = JSON.parse(raw) as {
    runtime: { version: string; path: string };
    manager: { version: string; path: string };
    toplevel?: string;
    hostAbi: number;
  };
  return {
    runtime: { version: j.runtime.version, outPath: j.runtime.path },
    manager: { version: j.manager.version, outPath: j.manager.path },
    toplevel: j.toplevel ?? '',
    hostAbi: j.hostAbi,
  };
}

/** A tuple with the versions a build will have (store paths evaluated, not built; NAR hashes zero), for check-newer. */
/** The manager a reused host's build carries (a runtime-only release keeps it), null without one. */
export function reusedManagerOf(
  b: { build: Record<string, unknown> } | null,
): { version: string; storePath: string } | null {
  const m = (b?.build.tuple as { manager?: { version?: string; storePath?: string } } | undefined)?.manager;
  return m?.version && m.storePath ? { version: m.version, storePath: m.storePath } : null;
}

/** `e` with the reused host's manager in place of the evaluated one, for the tuple the newer check sees. */
function withManagerOf(b: { build: Record<string, unknown> } | null, e: Evaluated): Evaluated {
  const m = reusedManagerOf(b);
  return m ? { ...e, manager: { version: m.version, outPath: m.storePath } } : e;
}

export function provisionalTuple(id: string, e: Evaluated, host: { version: string; storePath: string }) {
  const zero = `sha256:${'0'.repeat(64)}`;
  return {
    releaseId: id,
    runtime: {
      version: e.runtime.version,
      storePath: e.runtime.outPath,
      narHash: zero,
      schemaReads: { min: 0, max: 0 },
      schemaWrites: 0,
      protocol: { min: 1000, max: 1000 },
      hostAbi: { min: e.hostAbi, max: e.hostAbi },
    },
    providers: [],
    host: { version: host.version, storePath: host.storePath, narHash: zero, abi: e.hostAbi },
    manager: { version: e.manager.version, storePath: e.manager.outPath, narHash: zero },
  };
}

/**
 * `tufrepo check-newer` (MG-44) against the published repository verified from the root pinned in the build's own tree
 * ({@link pinnedRoot}): exit 0 “ok: publishing <id> would not be refused as older”; anything else refuses the build —
 * 1 older (stderr names the component, both versions and the release), expired or unverifiable metadata, 2 bad flags,
 * or no such command in an older tufrepo.
 */
async function checkNewer(
  bin: string,
  tuple: unknown,
  where: string[],
  file: string,
): Promise<{ ok: boolean; detail: string; unavailable?: true }> {
  writeFileSync(file, `${JSON.stringify(tuple, null, 2)}\n`);
  const r = await run(bin, ['check-newer', '--tuple', file, ...where], {
    cwd: join(file, '..'),
    timeoutMs: 120_000,
  });
  const out = `${r.stdout}\n${r.stderr}`.trim();
  if (r.code === 2 && /unknown (sub)?command|usage/i.test(out) && !/check-newer/.test(out))
    return { ok: false, detail: 'this tufrepo has no check-newer (MG-44)', unavailable: true };
  if (r.code === 2) throw new Error(`tufrepo check-newer: ${out.slice(-400)}`);
  return { ok: r.code === 0, detail: out.split('\n').slice(-6).join(' ').slice(0, 800) };
}

/** Host or runtime-only (UP-X16): what the build does and why. */
export interface HostDecision {
  class: 'host' | 'runtime';
  reason: string;
  /** The PROD release whose host (and its twin's) a runtime-only release reuses. */
  reuse: string | null;
  /** The automatic comparison: the newest PROD release, the host release it runs, both store paths. */
  compared: { release: string; hostRelease: string; expected: string; evaluated: string | null } | null;
}

export interface HostDeps {
  /** Release ids the Beta channel publishes (old `whombat-dev-` twins among them), null when unreadable. */
  published: () => Promise<string[] | null>;
  findBuild: (id: string) => { dir: string; build: Record<string, unknown> } | null;
  /** `release/build host-path <host build.json> --rev <rev>`; throws when the evaluation fails. */
  hostPath: (hostBuildJson: string) => Promise<{ host: string; expected: string; equal: boolean }>;
}

/**
 * UP-X16: `--reuse-host` and `--host` decide; otherwise the newest Beta release's host is compared with this commit's
 * host evaluated as that host was built (`hostPath`). Equal: runtime-only on that release; anything that can't be
 * compared, a release of the DEV image (ONE-02), or a different host: a host release. `runtime` is this commit's
 * runtime store path: the same as the newest release's with the same host leaves nothing to release.
 */
export async function decideHost(
  a: { reuseHost: string | null; forceHost: boolean },
  runtime: string,
  deps: HostDeps,
): Promise<HostDecision> {
  if (a.reuseHost)
    return { class: 'runtime', reason: `--reuse-host ${a.reuseHost}`, reuse: a.reuseHost, compared: null };
  if (a.forceHost) return { class: 'host', reason: '--host', reuse: null, compared: null };
  const host = (reason: string, compared: HostDecision['compared'] = null): HostDecision => ({
    class: 'host',
    reason,
    reuse: null,
    compared,
  });
  const published = await deps.published();
  if (!published) return host("Beta's published releases are unreadable: a host release");
  // One family (LNK-22, ONE-04): the DEV twins Beta carried before ONE-02 order with the image's own releases.
  const newest = published
    .map(parseReleaseId)
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((x, y) => compareIds(y, x))[0]?.id;
  if (!newest) return host('Beta publishes no release yet: a host release');
  if (parseReleaseId(newest)?.env !== 'prod')
    return host(`${newest}, Beta's newest release, is the DEV image's (ONE-02): a host release`);
  const nb = deps.findBuild(newest);
  const t = nb?.build.tuple as
    | { host?: { version?: string; storePath?: string }; runtime?: { storePath?: string } }
    | undefined;
  if (!nb || !t?.host?.version || !t.host.storePath)
    return host(`${newest}, Beta's newest release, has no build.json here: a host release`);
  const hostRelease = t.host.version;
  const hb = deps.findBuild(hostRelease);
  if (hb?.build.class !== 'host')
    return host(
      `${hostRelease}, the host release ${newest} runs, has no host build.json here: a host release`,
    );
  const compared = {
    release: newest,
    hostRelease,
    expected: t.host.storePath,
    evaluated: null as string | null,
  };
  let r: { host: string; expected: string; equal: boolean };
  try {
    r = await deps.hostPath(join(hb.dir, 'build.json'));
  } catch (err) {
    return host(
      `evaluating this commit's host as ${hostRelease}'s failed (${(err as Error).message.split('\n')[0]?.slice(0, 300)}): a host release`,
      compared,
    );
  }
  compared.evaluated = r.host;
  if (!r.equal || r.host !== t.host.storePath)
    return host(
      `this commit's host differs from ${hostRelease}'s (${r.host} ≠ ${t.host.storePath}): a host release`,
      compared,
    );
  if (t.runtime?.storePath === runtime)
    throw new Error(
      `nothing to release: this commit's host and runtime are those of ${newest}, Beta's newest release (--host builds a host release anyway)`,
    );
  return {
    class: 'runtime',
    reason: `only the runtime changed: this commit's host is ${hostRelease}'s (${r.host}); runtime-only on ${newest}`,
    reuse: newest,
    compared,
  };
}

/** `release/build host-path` of the build's worktree; its JSON line. */
async function hostPathOf(
  src: string,
  rev: string,
  hostBuildJson: string,
  log: string,
): Promise<{ host: string; expected: string; equal: boolean }> {
  const r = await run(buildScript(src), ['host-path', hostBuildJson, '--rev', rev], {
    cwd: src,
    logFile: log,
    timeoutMs: 1_800_000,
  });
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').at(-1) ?? `exit ${r.code}`);
  const j = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as {
    host?: string;
    expected?: string;
    equal?: boolean;
  };
  if (!j.host || !j.expected || typeof j.equal !== 'boolean')
    throw new Error(`host-path printed ${r.stdout.trim().slice(-200)}`);
  return { host: j.host, expected: j.expected, equal: j.equal };
}

export function findBuild(
  ctx: ShipContext,
  id: string,
): { dir: string; build: Record<string, unknown> } | null {
  for (const root of ctx.searchRoots) {
    const f = join(root, id, 'build.json');
    if (existsSync(f)) return { dir: join(root, id), build: JSON.parse(readFileSync(f, 'utf8')) };
  }
  return null;
}

/** The DEV twin of a PROD release: its build.json's `ship.twin`, else a dev build whose `ship.twinOf` names it. */
export function findTwin(ctx: ShipContext, prod: string): string | null {
  const b = findBuild(ctx, prod)?.build as { ship?: { twin?: { releaseId?: string } } } | undefined;
  if (b?.ship?.twin?.releaseId) return b.ship.twin.releaseId;
  for (const root of ctx.searchRoots) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) {
      if (parseReleaseId(d)?.env !== 'dev') continue;
      const f = join(root, d, 'build.json');
      if (!existsSync(f)) continue;
      const t = JSON.parse(readFileSync(f, 'utf8')) as { ship?: { twinOf?: string } };
      if (t.ship?.twinOf === prod) return d;
    }
  }
  return null;
}

/**
 * The root a build's newer check verifies the published repository from: the GitHub repository's root pinned in the
 * build's own tree, `manifest/prod/tuf-root.json`.
 */
export function pinnedRoot(src: string): string {
  const prod = join(src, 'manifest', 'prod', 'tuf-root.json');
  if (!existsSync(prod))
    throw new Error(
      `${prod} is missing: the newer check verifies the release repository from the root pinned there`,
    );
  return prod;
}

/**
 * The image's releases a channel's ids stand for: a `whombat-dev-` twin from before ONE-02 stands for the release it
 * was the twin of (its build.json's `ship.twinOf`), so the notes compare with the release Beta last had.
 */
export function asImageReleases(ids: readonly string[], twinOf: (dev: string) => string | null): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const r = parseReleaseId(id);
    if (r?.env === 'prod') out.add(id);
    else if (r?.env === 'dev') {
      const p = twinOf(id);
      if (p) out.add(p);
    }
  }
  return [...out];
}

export async function build(ctx: ShipContext, a: BuildArgs): Promise<void> {
  const prod = newProdId(a.prodId);
  const prodDir = join(ctx.root, prod.id);
  const logDir = join(ctx.logDir, prod.id);
  mkdirSync(logDir, { recursive: true });
  mkdirSync(ctx.root, { recursive: true });

  // 1. A clean commit: a release is rebuilt from its build.json (release/build refuses a dirty prod tree as well).
  const rev = await git(ctx.repo, ['rev-parse', 'HEAD']);
  const dirty = await git(ctx.repo, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw new Error(`the tree has uncommitted changes; commit first:\n${dirty}`);
  say(`${prod.id}: from ${rev.slice(0, 12)} (${await git(ctx.repo, ['log', '-1', '--format=%s'])})`);

  // Everything is evaluated and built from a worktree of the commit: the checkout may change while the build waits for
  // the heavy lock.
  const src = join(logDir, 'src');
  const dropSrc = () => run('git', ['-C', ctx.repo, 'worktree', 'remove', '--force', src], { cwd: ctx.repo });
  await dropSrc();
  await git(ctx.repo, ['worktree', 'add', '--detach', src, rev]);
  // The appliance in that worktree: Whombat's appliance/ folder.
  const source = findSource(rev, { checkout: ctx.repo });
  const app = applianceIn(src, source);
  try {
    if (!source.dir)
      throw new Error(
        `${rev.slice(0, 12)} is a commit of the appliance's old repository: its releases are made by the old flow (the maintainers' legacy-release runbook)`,
      );
    if (!a.runtimeStamp)
      throw new Error(
        'release/ship build needs --runtime-stamp <commit id>:<seconds since 1970>:<UTC YYYYMMDDHHMMSS>: the commit the runtime says it is (the candidate chooses it)',
      );
    const stamp = parseStamp(a.runtimeStamp);
    // A run that failed after its build resumes with it: release/build's own build.json of this id and commit, no
    // record yet. Anything else in the directory is refused.
    const built = (dir: string, id: string) => {
      const f = join(dir, 'build.json');
      if (!existsSync(f)) return null;
      const b = JSON.parse(readFileSync(f, 'utf8')) as BuildRecord & Record<string, unknown>;
      return b.releaseId === id && b.source?.rev === rev && !b.chain ? b : null;
    };
    if (existsSync(prodDir) && readdirSync(prodDir).length && !built(prodDir, prod.id))
      throw new Error(`${prodDir} exists and is not empty`);

    // 2. What the commit is built with, and its own checks: the versions' forms and the signed agents (a release
    // never ships agents nobody signed: the strict check passes only when the committed manifest signs these bytes).
    const cand = {
      name: a.candidate ?? 'unnamed',
      file: '',
      productVersion: a.candidate ?? 'unnamed',
      whombatRev: stamp.rev,
    };
    const versions = await versionsAt(src, rev);
    const contracts = versions.contracts;
    say(
      `candidate ${cand.name}: contracts ${contracts}, app ${versions.app}, the runtime's stamp ${stamp.rev.slice(0, 12)} of ${stamp.date}`,
    );
    for (const check of ['release-versions', 'hosts-agent-manifest']) {
      await nixBuild(`${flakeAt(app, rev)}#checks.x86_64-linux.${check}`, app, join(logDir, `${check}.log`));
      say(`checks.${check} ok`);
    }

    // 3. What the release will contain (evaluated, not built).
    const pe = await evaluate(app, rev, 'prod', prod.id, !a.reuseHost, stamp);
    // Host or runtime-only (UP-X16): --reuse-host, --host, or the comparison with Beta's newest release's host.
    const beta = () => channelReleaseIds(ctx.prod.releasesUrl, 'development');
    const hostDecision = await decideHost(a, pe.runtime.outPath, {
      published: beta,
      findBuild: (id) => findBuild(ctx, id),
      hostPath: (f) => hostPathOf(app, rev, f, join(logDir, 'host-path.log')),
    });
    say(`${hostDecision.class === 'host' ? 'a host release' : 'runtime-only'}: ${hostDecision.reason}`);
    const reuseHost = hostDecision.reuse;
    const reuse = reuseHost ? findBuild(ctx, reuseHost) : null;
    if (reuseHost && !reuse)
      throw new Error(`--reuse-host ${reuseHost}: no build.json in ${ctx.searchRoots.join(', ')}`);
    if (reuse && reuse.build.env !== 'prod')
      throw new Error(
        `--reuse-host ${reuseHost}: it is a ${String(reuse.build.env)} build, not the Whombat image's`,
      );
    // A runtime-only release (--reuse-host) keeps the reused host's manager, not this commit's.
    const reusedMgr = reusedManagerOf(reuse);
    say(
      `${prod.id}: runtime ${pe.runtime.version}, manager ${reusedMgr ? `${reusedMgr.version} (reused with the host of ${reuseHost})` : pe.manager.version}`,
    );

    // 4. Newer than what Beta publishes (UP-A3, ONE-04): a box takes a Beta release only when it sorts after Beta's
    // newest, and gh-publish refuses one that doesn't.
    const hostOf = (b: { build: Record<string, unknown> } | null, id: string, e: Evaluated) => {
      const h = (b?.build.tuple as { host?: { version: string; storePath: string } } | undefined)?.host;
      if (h) return { version: h.version, storePath: h.storePath };
      if (!e.toplevel) throw new Error(`${id}: no evaluated host or reused host record`);
      return { version: id, storePath: e.toplevel };
    };
    let newerCheck: ShipBuildFacts['newerCheck'];
    if (!a.newerCheck) {
      newerCheck = { skipped: '--no-newer-check' };
      say('newer check: skipped (--no-newer-check; gh-publish checks again when it publishes)');
    } else {
      const bin = await tufrepo(ctx, rev, app);
      const p = await checkNewer(
        bin,
        provisionalTuple(prod.id, withManagerOf(reuse, pe), hostOf(reuse, prod.id, pe)),
        ['--metadata-url', `${ctx.prod.releasesUrl}/`, '--channel', 'development', '--root', pinnedRoot(app)],
        join(logDir, 'newer-beta.tuple.json'),
      );
      if (p.unavailable)
        throw new Error('tufrepo has no check-newer in this tree (MG-44): --no-newer-check to build anyway');
      if (!p.ok) throw new Error(`not newer than Beta's published releases (UP-A3): ${p.detail}`);
      newerCheck = { channel: 'development', ok: true, detail: p.detail };
      say('newer check: Beta ok');
    }

    // 5. The build (heavy), from the worktree of the commit.
    const logs: string[] = [];
    const prodBuild = await (async () => {
      const before = built(prodDir, prod.id);
      if (before) {
        say(`${prod.id}: built from this commit before; resuming with it`);
        return before;
      }
      const log = join(logDir, `build-${prod.id}.log`);
      logs.push(log);
      say(`building ${prod.id} under ${ctx.heavyLock}; log ${log}`);
      const r = await heavy(
        ctx,
        buildScript(app),
        [
          'prod',
          prod.id,
          '--out',
          prodDir,
          '--runtime-stamp',
          stampArg(stamp),
          ...(reuse ? ['--reuse-host', join(reuse.dir, 'build.json')] : []),
        ],
        { cwd: app, logFile: log, timeoutMs: 6 * 3_600_000 },
      );
      if (r.code !== 0) throw new Error(`release/build prod ${prod.id} failed (${r.code}); see ${log}`);
      return JSON.parse(readFileSync(join(prodDir, 'build.json'), 'utf8')) as BuildRecord &
        Record<string, unknown>;
    })();
    if (reusedMgr && prodBuild.tuple.manager.storePath !== reusedMgr.storePath)
      throw new Error(`${prod.id} built another manager than the host it reuses (${reuseHost})`);

    // 6. Notes against the previous release Beta had (a DEV twin there stands for its PROD release).
    const known = new Set<string>();
    for (const root of ctx.searchRoots) if (existsSync(root)) for (const d of readdirSync(root)) known.add(d);
    const published = await beta();
    const twinOf = (dev: string) =>
      ((findBuild(ctx, dev)?.build.ship as { twinOf?: string } | undefined)?.twinOf ?? null) || null;
    const candidates = published
      ? asImageReleases(published, twinOf).filter((x) => known.has(x))
      : [...known];
    const previousId = a.previous ?? newestBefore(candidates, prod, 'prod');
    const previous = previousId ? findBuild(ctx, previousId) : null;
    if (previousId && !previous)
      say(`notes: ${previousId} has no build.json here; notes without a previous release`);
    const notes = await gatherNotes({
      applianceRepo: ctx.repo,
      current: prodBuild,
      previous: (previous?.build as unknown as BuildRecord) ?? null,
      twin: null,
      knownIssues: a.knownIssues,
      expandHome,
    });
    notes.delivery = {
      host: {
        class: hostDecision.class,
        reason: hostDecision.reason,
        reusedFrom: hostDecision.reuse,
        ...(hostDecision.compared ? { compared: hostDecision.compared } : {}),
      },
    };
    const notesText = `${JSON.stringify(notes, null, 2)}\n`;
    writeFileSync(join(prodDir, 'notes.json'), notesText);
    writeFileSync(join(prodDir, 'notes.md'), renderMarkdown(notes));
    say(`notes: ${notes.summary}`);

    // 7. The build.json starts the chain.
    const ship: ShipBuildFacts = {
      v: 1,
      devOnly: false,
      twin: null,
      candidate: cand,
      runtimeStamp: stamp,
      app: versions.app,
      newerCheck,
      storePaths: {
        runtime: prodBuild.tuple.runtime.storePath,
        manager: prodBuild.tuple.manager.storePath,
        equal: true,
      },
      contracts,
      knownIssues: a.knownIssues,
      notes: { sha256: sha256Hex(notesText), summary: notes.summary },
      previous: previous ? (previousId ?? null) : null,
      host: hostDecision,
      logs,
    };
    const skipped = 'skipped' in newerCheck ? [`newer check skipped (${newerCheck.skipped})`] : [];
    const chain = nextChain(prodDir, prod.id, 'build', {
      twin: null,
      ok: true,
      complete: !skipped.length,
      notes: skipped,
    });
    const sha = writeRecord(prodDir, 'build', { ...prodBuild, ship, chain } as ChainedRecord);
    say(`build.json ${sha.slice(0, 12)}: ${prod.id}`);
    process.stdout.write(
      `${JSON.stringify({ releaseId: prod.id, dir: prodDir, buildSha256: sha, complete: !skipped.length })}\n`,
    );
  } finally {
    await dropSrc();
  }
}
