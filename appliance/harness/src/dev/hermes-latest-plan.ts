/**
 * The latest-tested Hermes job's decisions and file edits (Whombat HU-03, HU-06; NX-485), without I/O: which Hermes
 * release is new, and how the pin moves, in one commit: the runtime's `packages/agent-runtime/src/hermes/pin.ts`, and
 * in the appliance folder `flake.nix`'s `hermes` input and the uv2nix inputs at that release's `flake.lock` revisions and
 * `nix/packages/hermes`'s `version` and `pinnedRev`. The job is `hermes-latest.ts`.
 */

/** Hermes's pin as Whombat's pin.ts names it. */
export interface HermesPin {
  version: string;
  tag: string;
  commit: string;
}

/** What GitHub's releases API says of a release (the fields the job reads). */
export interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
}

const STABLE_TAG = /^v(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

/**
 * The version of a stable release tag: `v0.23.0` → `0.23.0`. Null for everything else: a `+canary` tag, a pre-release
 * suffix, and Hermes's older calendar tags (`v2026.9.24`, before its SemVer releases since 0.22.0), which would sort
 * above every SemVer one.
 */
export function stableVersion(tag: string): string | null {
  const m = STABLE_TAG.exec(tag);
  if (!m) return null;
  if (Number(m[1]) >= 1000) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

/** Orders `x.y.z` numerically. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest stable release (published, not a pre-release, a SemVer tag): its tag and version, or null. */
export function newestStable(releases: readonly GithubRelease[]): { tag: string; version: string } | null {
  let best: { tag: string; version: string } | null = null;
  for (const r of releases) {
    if (r.draft || r.prerelease) continue;
    const version = stableVersion(r.tag_name);
    if (version && (!best || compareSemver(version, best.version) > 0)) best = { tag: r.tag_name, version };
  }
  return best;
}

const PIN_FIELD = (key: string) => new RegExp(`^(\\s*${key}:\\s*')([^']*)(',?)$`, 'm');

/** Whombat's pin.ts: the pinned version, tag and commit. */
export function readPinTs(text: string): HermesPin {
  const get = (key: string) => {
    const m = PIN_FIELD(key).exec(text);
    if (!m?.[2]) throw new Error(`pin.ts names no ${key}`);
    return m[2];
  };
  return { version: get('version'), tag: get('tag'), commit: get('commit') };
}

/** Whombat's pin.ts moved to `pin` (its comment and layout kept). */
export function setPinTs(text: string, pin: HermesPin): string {
  let out = text;
  for (const [key, value] of Object.entries(pin)) {
    const re = PIN_FIELD(key);
    if (!re.test(out)) throw new Error(`pin.ts names no ${key}`);
    out = out.replace(re, `$1${value}$3`);
  }
  return out;
}

const HERMES_URL = /^(\s*url = "github:NousResearch\/hermes-agent\/)([0-9a-f]{40})(";)(\s*#\s*v\S+)?$/m;

/** The appliance's flake.nix: Hermes's pinned commit and the release named beside it. */
export function readFlakeHermes(flake: string): { rev: string; tag: string | null } {
  const m = HERMES_URL.exec(flake);
  if (!m?.[2]) throw new Error('flake.nix has no `hermes` url at a commit of NousResearch/hermes-agent');
  return { rev: m[2], tag: m[4]?.replace(/^\s*#\s*/, '') ?? null };
}

/** The appliance's flake.nix with Hermes at `rev`, named `tag`. */
export function setFlakeHermes(flake: string, rev: string, tag: string): string {
  if (!HERMES_URL.test(flake))
    throw new Error('flake.nix has no `hermes` url at a commit of NousResearch/hermes-agent');
  return flake.replace(HERMES_URL, `$1${rev}$3 # ${tag}`);
}

/** The uv2nix tool chain's inputs, as this flake and Hermes's flake.lock name them, and their repositories. */
export const UV2NIX_INPUTS = {
  'pyproject-nix': 'pyproject-nix/pyproject.nix',
  uv2nix: 'pyproject-nix/uv2nix',
  'pyproject-build-systems': 'pyproject-nix/build-system-pkgs',
} as const;
export type Uv2nixInput = keyof typeof UV2NIX_INPUTS;

interface FlakeLock {
  root: string;
  nodes: Record<
    string,
    { inputs?: Record<string, string | string[]>; locked?: { owner?: string; repo?: string; rev?: string } }
  >;
}

/**
 * The revisions Hermes's own flake.lock gives its uv2nix tool chain (NX-430: ours follow them, on our nixpkgs): the
 * root's input of that name, else the one node locked to that repository.
 */
export function uv2nixRevs(lockJson: string): Record<Uv2nixInput, string> {
  const lock = JSON.parse(lockJson) as FlakeLock;
  const root = lock.nodes[lock.root]?.inputs ?? {};
  const out = {} as Record<Uv2nixInput, string>;
  for (const [input, repo] of Object.entries(UV2NIX_INPUTS) as [Uv2nixInput, string][]) {
    const named = root[input];
    let node = typeof named === 'string' ? lock.nodes[named] : undefined;
    if (!node?.locked?.rev) {
      const [owner, name] = repo.split('/');
      const byRepo = Object.values(lock.nodes).filter(
        (n) => n.locked?.owner === owner && n.locked?.repo === name && n.locked?.rev,
      );
      const revs = new Set(byRepo.map((n) => n.locked?.rev));
      if (revs.size !== 1) throw new Error(`Hermes's flake.lock: no single ${repo} (${revs.size} revisions)`);
      node = byRepo[0];
    }
    const rev = node?.locked?.rev;
    if (!rev || !/^[0-9a-f]{40}$/.test(rev)) throw new Error(`Hermes's flake.lock: no revision for ${input}`);
    out[input] = rev;
  }
  return out;
}

/** The appliance's flake.nix with the uv2nix inputs at `revs`. */
export function setFlakeUv2nix(flake: string, revs: Record<Uv2nixInput, string>): string {
  let out = flake;
  for (const [input, repo] of Object.entries(UV2NIX_INPUTS) as [Uv2nixInput, string][]) {
    const re = new RegExp(`^(\\s*url = "github:${repo.replace('.', '\\.')}/)([0-9a-f]{40})(";)$`, 'm');
    if (!re.test(out)) throw new Error(`flake.nix has no ${input} url at a commit of ${repo}`);
    out = out.replace(re, `$1${revs[input]}$3`);
  }
  return out;
}

const PKG_VERSION = /^(\s*version = ")([^"]+)(";)$/m;
const PKG_REV = /^(\s*pinnedRev = ")([0-9a-f]{40})(";)$/m;

/** nix/packages/hermes/default.nix: the release it says it builds. */
export function readHermesPackage(nix: string): { version: string; rev: string } {
  const v = PKG_VERSION.exec(nix)?.[2];
  const r = PKG_REV.exec(nix)?.[2];
  if (!v || !r) throw new Error('nix/packages/hermes/default.nix has no `version` and `pinnedRev`');
  return { version: v, rev: r };
}

/** nix/packages/hermes/default.nix at `version`, `rev` (the package refuses a flake input at another commit). */
export function setHermesPackage(nix: string, version: string, rev: string): string {
  readHermesPackage(nix);
  return nix.replace(PKG_VERSION, `$1${version}$3`).replace(PKG_REV, `$1${rev}$3`);
}

/** What the candidate's `--what` and `--why` say (HU-06: the box's “Updated to …” names Hermes). */
export function candidateWords(version: string): { what: string; why: string } {
  return {
    what: `hermes agent ${version}`,
    why: `Hermes Agent ${version} came out and passed Whombat's tests.`,
  };
}

/**
 * Whether a main that moved since the test can take the tested pin commit anyway: none of the files the test covered
 * changed in between (`changed` lists the paths that did). Otherwise the next run tests again.
 */
export function movedOutsideTest(changed: readonly string[], covered: readonly string[]): boolean {
  return !changed.some((f) => covered.some((c) => f === c || f.startsWith(c.endsWith('/') ? c : `${c}/`)));
}

/**
 * What the test covered that another commit could break for this Hermes, as paths from the repository's root: the
 * plugin, the code that drives Hermes, how the appliance builds and carries it, and the test that ran it. Anything else
 * on a main that moved meanwhile is any change's, which `candidate` builds (the runtime with its Hermes, its install and
 * activation checks) before it ships.
 */
export const COVERED = [
  'packages/hermes-whombat',
  'packages/agent-runtime/src/hermes',
  'appliance/nix/packages/hermes',
  'appliance/nix/modules/hermes.nix',
  'appliance/vm-tests/runtime-live-turn.nix',
] as const;

/** How long a new version waits for its review (NX-492) before the job tests it as it is. */
export const REVIEW_WAIT_MS = 2 * 24 * 60 * 60_000;

/**
 * What the daily run does with a new version when a review is set up (NX-492): ask for one (no `review` marker yet),
 * wait for it (asked less than `REVIEW_WAIT_MS` ago), or test it as it is (nobody reviewed it in time).
 */
export function reviewStep(askedAtMs: number | null, nowMs: number): 'ask' | 'wait' | 'test' {
  if (askedAtMs === null) return 'ask';
  return nowMs - askedAtMs < REVIEW_WAIT_MS ? 'wait' : 'test';
}

/** What the review marker holds: the release the review is for (NX-492). */
export function reviewRequest(
  version: string,
  tag: string,
  pinned: string,
  upstream: string,
): Record<string, string> {
  return {
    event: 'hermes-release',
    version,
    tag,
    pinned,
    release: `https://github.com/${upstream}/releases/tag/${tag}`,
  };
}
