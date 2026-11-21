/**
 * What a candidate from the one repository ships, decided before anything is built (dev/candidate.ts; Whombat
 * docs/decisions/one-repo.md). A release is one commit of `main`. Three things of a box can be new with it, and each
 * has its own rule for when it is:
 *
 *   the runtime   kept, version and bytes, while this commit builds the very runtime Beta's newest release published;
 *                 otherwise a new one, stamped with this commit
 *   the agents    signed again only when their bytes changed, under a version strictly later than the published one
 *   the image     a host release when this commit's image differs from the one Beta's boxes run
 *
 * Together with the hosted parts (control, the relay, the account site, the embed) that gives the kind of the release.
 * The plan is written to the run's folder (`plan.json`) and every later step, and a run that carries on, reads it from
 * there: nothing is decided twice. Pure: no file, no git, no Nix here.
 */
import type { CloudPart, HostedDeploy } from './candidate-plan.ts';

/** The commit a runtime bundle says it is: its id, its commit time, and that time as UTC YYYYMMDDHHMMSS. */
export interface Stamp {
  rev: string;
  time: number;
  date: string;
}

export function stampOf(rev: string, time: number): Stamp {
  if (!/^[0-9a-f]{40}$/.test(rev)) throw new Error(`a stamp needs a full commit id, not ${rev}`);
  if (!Number.isInteger(time) || time <= 0) throw new Error(`a stamp needs a commit time, not ${time}`);
  const date = new Date(time * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return { rev, time, date };
}

/** `<rev>:<time>:<date>`, as `release/build --runtime-stamp` takes it. */
export const stampArg = (s: Stamp) => `${s.rev}:${s.time}:${s.date}`;

/** The runtime's version under a stamp (nix/packages/runtime: `<package.json>-<commit time>.<short rev>`). */
export const runtimeVersion = (packageVersion: string, s: Stamp) =>
  `${packageVersion}-${s.date}.${s.rev.slice(0, 7)}`;

/** The agents' version when they are signed at a commit (`0.0.0-<commit time>.<short rev>`, as agents order them). */
export const agentVersion = (s: Stamp) => `0.0.0-${s.date}.${s.rev.slice(0, 7)}`;

/** The runtime Beta's newest release published: what a new release may keep. */
export interface PublishedRuntime {
  release: string;
  stamp: Stamp;
  storePath: string;
  narHash: string;
}

export interface RuntimeChoice {
  /** The published runtime stays: nothing is built and no box downloads a runtime. */
  kept: boolean;
  /** The stamp the release is built with: the published one when kept, this commit's otherwise. */
  stamp: Stamp;
  /** The release whose runtime is kept. */
  from: string | null;
  why: string;
}

/**
 * The runtime of a release at `commit`. Kept only when it is the very same object: this commit, built under the
 * published stamp, is the published store path (`evaluated`), and that path is still in this machine's store with the
 * hash that was published (`inStore`). Anything else is a new runtime under this commit's stamp: a published version
 * is never built again, because the same version with other bytes is what the update repository refuses.
 */
export function chooseRuntime(o: {
  published: PublishedRuntime | null;
  /** This commit's runtime store path under the published stamp, null when it couldn't be evaluated. */
  evaluated: string | null;
  /** The NAR hash of the published store path in this machine's store, null when it is not there. */
  inStore: string | null;
  commit: Stamp;
}): RuntimeChoice {
  const fresh = (why: string): RuntimeChoice => ({ kept: false, stamp: o.commit, from: null, why });
  const p = o.published;
  if (!p) return fresh('Beta has no release with a runtime to keep');
  if (o.evaluated === null)
    return fresh(`this commit's runtime under ${p.release}'s stamp couldn't be evaluated`);
  if (o.evaluated !== p.storePath)
    return fresh(`the runtime changed since ${p.release} (${o.evaluated} is not its ${p.storePath})`);
  if (o.inStore === null)
    return fresh(
      `the runtime is ${p.release}'s, but that store object is gone from this machine: a new version, never the old one built again`,
    );
  if (o.inStore !== p.narHash)
    return fresh(
      `the runtime is ${p.release}'s by its path, but this machine's object has another hash than was published: a new version`,
    );
  return {
    kept: true,
    stamp: p.stamp,
    from: p.release,
    why: `the runtime is ${p.release}'s, unchanged and still in the store`,
  };
}

/**
 * A NAR hash as a release tuple names it (`sha256:<hex>`), from the form Nix prints (`sha256-<base64>`); a hash that
 * is in the tuple's form already stays as it is. Null when it is neither.
 */
export function tupleNarHash(hash: string): string | null {
  if (/^sha256:[0-9a-f]{64}$/.test(hash)) return hash;
  const m = /^sha256-([A-Za-z0-9+/]{43}=)$/.exec(hash);
  return m ? `sha256:${Buffer.from(m[1] as string, 'base64').toString('hex')}` : null;
}

/** The manifest check's outcomes (nix/packages/hosts/manifest-check): a match, other bytes, anything else. */
export type ManifestCheck = 0 | 1 | 3;

export interface AgentsChoice {
  action: 'unchanged' | 'sign';
  /** The agents' version in the release: the committed one, or the one they are signed as. */
  version: string;
  why: string;
}

/**
 * Whether the agents are signed again. Only "other bytes" leads to signing; a manifest that is broken in any other
 * way stops the run, since signing again would hide it.
 */
export function chooseAgents(o: {
  check: ManifestCheck;
  committed: string;
  commit: Stamp;
  detail?: string;
}): AgentsChoice {
  if (o.check === 0)
    return { action: 'unchanged', version: o.committed, why: 'the agents are the signed ones' };
  if (o.check === 3)
    return {
      action: 'sign',
      version: agentVersion(o.commit),
      why: `the agents' bytes changed since they were signed as ${o.committed}`,
    };
  throw new Error(
    `the agent manifest is not one for these agents, and that is not a change of their bytes${o.detail ? ` (${o.detail})` : ''}: nothing is signed until someone has looked`,
  );
}

/**
 * What the first release from the one repository must be: the code boxes already run, built another way. Null when
 * it may go on, else why not.
 *
 * - Its agents are the ones servers have. An agent never takes an older version back, so an agent update is the one
 *   part of a release that can't be undone; if the agents built here differ from the signed ones, the build is not
 *   the same across the move, and that is found out before any server is offered one.
 * - Its runtime writes the database schema the last release wrote. A box that took it must still be able to go back
 *   through the old release flow, and an older runtime can't read a newer schema.
 */
export function firstReleaseRefusal(o: {
  /** No release of the one repository is recorded yet. */
  first: boolean;
  agents?: AgentsChoice['action'];
  schema?: { writes: number | null; lastWrites: number | null; last: string | null };
}): string | null {
  if (!o.first) return null;
  if (o.agents === 'sign')
    return 'the first release from the one repository must carry the agents servers already have, and the agents built from this commit are not the signed ones: the build is not the same across the move. Nothing was signed. Find out which input differs before any server is offered an agent it can never take back';
  const s = o.schema;
  if (s && s.lastWrites !== null && s.writes !== s.lastWrites)
    return `the first release from the one repository adds no database change, and this build writes schema ${s.writes ?? '?'} where ${s.last ?? 'the last release'} wrote ${s.lastWrites}: ship the migration with the old flow first, or after this release`;
  return null;
}

/**
 * The five kinds of a run.
 *   host            the image and the runtime changed: host, manager and runtime go out
 *   host-kept       only the image changed: host and manager go out, the runtime is the published one
 *   runtime         only the runtime changed: it goes out on the host Beta's boxes run
 *   hosted          nothing of a box changed, a hosted part is deployed: no release, no Beta step
 *   nothing         neither
 */
export type Kind = 'host' | 'host-kept' | 'runtime' | 'hosted' | 'nothing';

export const KIND_WORDS: Record<Kind, string> = {
  host: 'a host release with a new runtime',
  'host-kept': 'a host release that keeps the published runtime',
  runtime: 'a runtime-only release',
  hosted: 'hosted parts only, no release',
  nothing: 'nothing to ship',
};

/** Whether a kind makes a release for boxes. */
export const isRelease = (k: Kind) => k === 'host' || k === 'host-kept' || k === 'runtime';

export function kindOf(o: { imageChanged: boolean; runtimeKept: boolean; hosted: number }): Kind {
  if (o.imageChanged) return o.runtimeKept ? 'host-kept' : 'host';
  if (!o.runtimeKept) return 'runtime';
  return o.hosted > 0 ? 'hosted' : 'nothing';
}

export interface HostChoice {
  /** A host release: the image changed (or `--host`, or new agents, which the hub in the image carries). */
  changed: boolean;
  /** The release whose host a runtime-only release runs on. */
  reuse: string | null;
  why: string;
}

/**
 * Whether the image goes out. New agents always make a host release: the hub that hands them out is part of the
 * image. `compared` is the comparison of this commit's image with the host Beta's boxes run (release/build host-path),
 * null when there is nothing to compare with.
 */
export function chooseHost(o: {
  force: boolean;
  agents: AgentsChoice['action'];
  compared: { hostRelease: string; equal: boolean } | null;
  /** Why there is nothing to compare with. */
  incomparable?: string;
}): HostChoice {
  if (o.force) return { changed: true, reuse: null, why: '--host' };
  if (o.agents === 'sign')
    return { changed: true, reuse: null, why: 'new agents: the hub that hands them out is in the image' };
  if (!o.compared)
    return { changed: true, reuse: null, why: o.incomparable ?? 'no published host to compare with' };
  if (!o.compared.equal)
    return { changed: true, reuse: null, why: `the image differs from ${o.compared.hostRelease}'s` };
  return { changed: false, reuse: o.compared.hostRelease, why: `the image is ${o.compared.hostRelease}'s` };
}

const parse = (v: string): [number, number, number] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmp = (a: readonly number[], b: readonly number[]) =>
  (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);

/**
 * The first candidate number of the one repository: one minor above the old flow's last candidate. The two flows
 * share the runs' folders (`rel-<version>`), so their numbers must never meet: the old flow keeps the minor it was at
 * when releases moved here and counts patches from then on, and this one starts at the next minor. `legacy` are the
 * old flow's candidates (the names of its candidate manifests), so the border follows from what the old flow did
 * last and nobody sets it. Without any (a repository that never had the old flow) numbers start at 0.1.0.
 */
export function firstVersion(legacy: readonly string[]): string {
  const newest = legacy
    .map(parse)
    .filter((v): v is [number, number, number] => v !== null)
    .sort(cmp)
    .at(-1);
  return newest ? `${newest[0]}.${newest[1] + 1}.0` : '0.1.0';
}

/**
 * The number an old-flow release takes after releases moved here (the maintainers' legacy-release runbook): the next
 * patch of the old flow's own minor, which this flow never uses. `taken` are the numbers that minor has already (the
 * old flow's manifests and the runs' folders).
 */
export function legacyVersion(legacy: readonly string[], taken: readonly string[] = []): string {
  const newest = legacy
    .map(parse)
    .filter((v): v is [number, number, number] => v !== null)
    .sort(cmp)
    .at(-1);
  if (!newest) throw new Error('the old flow left no candidate to count on from');
  const patch = [...legacy, ...taken]
    .map(parse)
    .filter((v): v is [number, number, number] => v !== null && v[0] === newest[0] && v[1] === newest[1])
    .reduce((max, v) => Math.max(max, v[2]), newest[2]);
  return `${newest[0]}.${newest[1]}.${patch + 1}`;
}

/** `<rev>:<time>:<date>` back into a stamp. */
export function parseStamp(arg: string): Stamp {
  const m = /^([0-9a-f]{40}):([1-9][0-9]{0,11}):([0-9]{14})$/.exec(arg);
  if (!m)
    throw new Error(`a runtime stamp is <commit id>:<seconds since 1970>:<UTC YYYYMMDDHHMMSS>, not ${arg}`);
  const s = stampOf(m[1] as string, Number(m[2]));
  if (s.date !== m[3])
    throw new Error(`the runtime stamp ${arg} names ${m[3]}, which is not the time ${m[2]}`);
  return s;
}

/**
 * The next candidate number after the ones the release records hold (`ops/records/releases/<version>.json`): `first`
 * ({@link firstVersion}) when there is none yet, else the newest plus one patch (or minor). `--version` is taken as
 * given when it is free and not below the first.
 */
export function nextVersion(
  existing: readonly string[],
  bump: 'patch' | 'minor',
  requested: string | null,
  first: string,
): string {
  const floor = parse(first);
  if (!floor) throw new Error(`the first candidate number ${first} is not x.y.z`);
  const known = existing
    .map(parse)
    .filter((v): v is [number, number, number] => v !== null && cmp(v, floor) >= 0);
  if (requested) {
    const r = parse(requested);
    if (!r) throw new Error('--version takes x.y.z');
    if (cmp(r, floor) < 0)
      throw new Error(
        `--version ${requested}: candidates of the one repository start at ${first}, one minor above the old flow's last (the numbers below are the old flow's)`,
      );
    if (known.some((k) => cmp(k, r) === 0)) throw new Error(`--version ${requested} is a release already`);
    return requested;
  }
  const newest = known.sort(cmp).at(-1);
  if (!newest) return first;
  return bump === 'minor' ? `${newest[0]}.${newest[1] + 1}.0` : `${newest[0]}.${newest[1]}.${newest[2] + 1}`;
}

/**
 * Whether a run removes a whole-tree copy from the Nix store after it. Nix copies a commit's whole tree into its store
 * before it reads the flake (340 MB a commit here), and nothing uses the copy afterwards: every build reads a narrow
 * copy of its own. A run removes only what is its own and unused: a path a flake it read resolved to, registered
 * since the run began, that no other store path refers to. The store itself still refuses a path something roots.
 */
export function dropsCopy(o: {
  path: string;
  /** When the store registered the path, seconds since 1970; null when the store doesn't know it. */
  registeredAt: number | null;
  /** When the run began, seconds since 1970. */
  since: number;
  /** Other store paths that refer to it. */
  referrers: readonly string[];
}): { drop: boolean; why: string } {
  if (!/^\/nix\/store\/[0-9a-z]{32}-source$/.test(o.path))
    return { drop: false, why: 'not a copy of a source tree' };
  if (o.registeredAt === null) return { drop: false, why: 'not in the store' };
  if (o.registeredAt < o.since) return { drop: false, why: 'it was there before this run' };
  if (o.referrers.length) return { drop: false, why: `${o.referrers.length} store paths refer to it` };
  return { drop: true, why: 'made by this run, and nothing refers to it' };
}

/** The steps of a run, in order. A run that stopped carries on after the last one its plan records as done. */
export const STEPS = ['plan', 'prep', 'build', 'hosted', 'beta', 'record'] as const;
export type Step = (typeof STEPS)[number];

export interface ReleasePlan {
  v: 1;
  /** The candidate's number. */
  version: string;
  what: string;
  why: string;
  /** The commit of `main` the run started from. */
  commit: string;
  kind: Kind;
  /** The release's id, null for a run that makes none. */
  releaseId: string | null;
  runtime: RuntimeChoice;
  agents: AgentsChoice;
  host: HostChoice;
  /** The contracts version the commit is built with: control must speak it before anything goes out. */
  contracts: string;
  /** `--cloud`: the whombat-cloud commit and the parts of it that are deployed. */
  cloud: { rev: string; parts: CloudPart[] } | null;
  web: { deploy: boolean; why: string };
  /** The hosted deploys, in order. */
  hosted: HostedDeploy[];
  /**
   * The release-prep commit: generated files that went stale (a fixed hash, the agents' signatures), committed on
   * `main` before the build. Most runs need none. `commit` is filled in once it is pushed; the release is built from
   * it, or from `commit` above when there is none.
   */
  prep: { hashes: string[]; sign: boolean; commit: string | null };
  /** The steps done so far. */
  done: Step[];
  at: string;
  /**
   * When the run that made the plan began. What it left in the Nix store since then is its own, also for a run that
   * carries on later.
   */
  began?: string;
}

/** The commit a plan's release is built from: its release-prep commit when it made one. */
export const releaseCommit = (p: ReleasePlan) => p.prep.commit ?? p.commit;

/** Whether a plan needs a release-prep commit. */
export const needsPrep = (p: Pick<ReleasePlan, 'prep'>) => p.prep.sign || p.prep.hashes.length > 0;

/** The first step a run still has to do, null when all are done. */
export function nextStep(p: Pick<ReleasePlan, 'done' | 'kind' | 'prep' | 'hosted'>): Step | null {
  for (const step of STEPS) {
    if (p.done.includes(step)) continue;
    if (step === 'prep' && !needsPrep(p)) continue;
    if ((step === 'build' || step === 'beta') && !isRelease(p.kind)) continue;
    if (step === 'hosted' && p.hosted.length === 0) continue;
    if (step !== 'plan' && p.kind === 'nothing') continue;
    return step;
  }
  return null;
}

export function parsePlan(json: string): ReleasePlan {
  const p = JSON.parse(json) as ReleasePlan;
  if (p.v !== 1 || !p.version || !p.commit || !p.kind || !Array.isArray(p.done))
    throw new Error('plan.json is not a plan this candidate wrote');
  return p;
}

/**
 * Whether a run carries on with a plan it finds: the plan is unfinished, was made for the same request (the same
 * `--cloud` commit, the same `--version` when one is asked for) and its commit is still on `main`. A plan that
 * doesn't fit is left alone and the run makes a new one under the next number.
 */
export function resumes(
  p: ReleasePlan,
  o: { cloud: string | null; version: string | null; onMain: boolean; fresh?: boolean },
): { resume: boolean; why: string } {
  if (nextStep(p) === null) return { resume: false, why: `candidate ${p.version} is finished` };
  if (o.fresh)
    return {
      resume: false,
      why: `--new: candidate ${p.version}, which stopped before “${nextStep(p)}”, is left as it is`,
    };
  if (o.version && o.version !== p.version)
    return { resume: false, why: `it is candidate ${p.version}, not ${o.version}` };
  if ((p.cloud?.rev ?? null) !== o.cloud)
    return {
      resume: false,
      why: `candidate ${p.version} was planned with ${p.cloud ? `--cloud ${p.cloud.rev.slice(0, 7)}` : 'no --cloud'}`,
    };
  if (!o.onMain) return { resume: false, why: `candidate ${p.version}'s commit is no longer on main` };
  return { resume: true, why: `candidate ${p.version} stopped before “${nextStep(p)}”` };
}

/** What a run says it will do, one line. */
export function planWords(p: ReleasePlan): string {
  const parts = [KIND_WORDS[p.kind]];
  if (isRelease(p.kind)) {
    parts.push(
      p.runtime.kept
        ? `runtime kept (${p.runtime.from})`
        : `runtime new (${p.runtime.stamp.rev.slice(0, 7)} of ${p.runtime.stamp.date})`,
    );
    parts.push(
      p.agents.action === 'sign'
        ? `agents signed as ${p.agents.version}`
        : `agents ${p.agents.version}, unchanged`,
    );
    if (p.host.reuse) parts.push(`on the host of ${p.host.reuse}`);
  }
  parts.push(p.hosted.length ? `hosted: ${p.hosted.map((h) => h.part).join(', ')}` : 'nothing hosted');
  return parts.join('; ');
}

/** A release's record in ops (`records/releases/<version>.json`): what went out and from which commit. */
export interface ReleaseRecord {
  v: 1;
  version: string;
  releaseId: string | null;
  kind: Kind;
  commit: string;
  what: string;
  why: string;
  runtime: { kept: boolean; from: string | null; stamp: Stamp; version: string | null };
  agents: { version: string; signed: boolean };
  host: { reuse: string | null };
  contracts: string;
  cloud: { rev: string; parts: CloudPart[] } | null;
  hosted: { part: string; ref: string }[];
  channel: 'development' | null;
  at: string;
}

export function recordOf(
  p: ReleasePlan,
  o: { runtimeVersion: string | null; hosted: readonly HostedDeploy[]; at: string },
): ReleaseRecord {
  return {
    v: 1,
    version: p.version,
    releaseId: p.releaseId,
    kind: p.kind,
    commit: releaseCommit(p),
    what: p.what,
    why: p.why,
    runtime: {
      kept: p.runtime.kept,
      from: p.runtime.from,
      stamp: p.runtime.stamp,
      version: o.runtimeVersion,
    },
    agents: { version: p.agents.version, signed: p.agents.action === 'sign' },
    host: { reuse: p.host.reuse },
    contracts: p.contracts,
    cloud: p.cloud,
    hosted: o.hosted.map((h) => ({ part: h.part, ref: h.ref })),
    channel: isRelease(p.kind) ? 'development' : null,
    at: o.at,
  };
}
