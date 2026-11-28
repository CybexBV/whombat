/**
 * The pure parts of whombat-ops `candidate` (IN-296, IN-314, IN-377; ONE-19): the next candidate's numbers and pins,
 * the edits to the files that pin Whombat and whombat-hosts, the words it writes, which release it builds on and
 * whether it has anything to ship (from the builds recorded here and the Beta channel), and which hosted parts it
 * deploys to production. No I/O here: candidate.ts does the work, these are unit-tested.
 */
import { compareIds, compareVersions, parseReleaseId } from '../ship/ids.ts';

export interface Component {
  id: string;
  repository: string;
  source?: string;
  /** Its folder in the repository, for commits that hold it in one (whombat-cloud's `control`, `relay`). */
  dir?: string;
  ref?: string;
  commit?: string;
  tag?: string;
  version?: string;
  [k: string]: unknown;
}

export interface CandidateManifest {
  productVersion: string;
  updatedAt: number;
  contracts: { version: string; component: string };
  components: Component[];
  tuple: { releaseId: string; [k: string]: unknown };
  [k: string]: unknown;
}

type Semver = [number, number, number];

function semver(v: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const cmp = (a: Semver, b: Semver) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The newest candidate among `manifest/candidates/*.json` file names (`0.102.1.json`). */
export function newestCandidate(files: readonly string[]): string {
  let best: Semver | null = null;
  for (const f of files) {
    const v = semver(f.replace(/\.json$/, ''));
    if (v && (!best || cmp(v, best) > 0)) best = v;
  }
  if (!best) throw new Error('no candidate in manifest/candidates');
  return best.join('.');
}

/** The next candidate after `prev`: a fix bumps the patch, `minor` the minor. */
export function nextVersion(prev: string, bump: 'patch' | 'minor'): string {
  const v = semver(prev);
  if (!v) throw new Error(`candidate ${prev} is not x.y.z`);
  return bump === 'minor' ? `${v[0]}.${v[1] + 1}.0` : `${v[0]}.${v[1]}.${v[2] + 1}`;
}

const utcDay = (now: Date, sep: string) =>
  [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()]
    .map((n, i) => String(n).padStart(i ? 2 : 4, '0'))
    .join(sep);

export interface Pins {
  whombatRev: string;
  /**
   * `inWhombat`: the app is the Whombat commit's own apps/ (since whombat-app moved into Whombat), not a vendored release.
   * `hasAdmin` false: that commit has no operator panel (`apps/admin` moved to control's repository), so its build and artifact go.
   */
  app: { version: string; commit: string; inWhombat?: boolean; hasAdmin?: boolean };
  /** Only when Whombat holds or vendors other contracts than the previous candidate; `inWhombat` as for the app. */
  contracts?: { version: string; commit: string; inWhombat?: boolean };
  /** `--hosts`: the whombat-hosts commit (IN-314); otherwise it stays as the previous candidate pins it. */
  hostsRev?: string;
  /**
   * `--cloud`: the whombat-cloud commit, for the parts that move to it ({@link cloudPinned}); the others stay as the
   * previous candidate pins them.
   */
  cloud?: { rev: string; parts: readonly CloudPart[] };
}

/* Control and the relay: whombat-cloud's control/ and relay/ ---------------------------------------------------- */

/** The hosted parts that are folders of the private repository whombat-cloud. */
export const CLOUD_PARTS = ['control', 'relay'] as const;
export type CloudPart = (typeof CLOUD_PARTS)[number];

/**
 * The pins' component of each part. The ids are the repositories they were before they became whombat-cloud's
 * folders: `repository` is the contracts' `RepositoryName`, which has no other name for them.
 */
export const CLOUD_COMPONENT: Record<CloudPart, string> = { control: 'whombat-api', relay: 'whombat-relay' };

/** Where whombat-cloud is checked out (`WHOMBAT_CLOUD` names another place) and fetched from. */
export const CLOUD_CHECKOUT = '~/Code/whombat-cloud';
export const CLOUD_GIT_URL = 'git@github.com:CybexBV/whombat-cloud.git';

/** A component's place when it is a folder of whombat-cloud. */
export function inCloud(part: CloudPart): Pick<Component, 'source' | 'live' | 'remote' | 'dir'> {
  return { source: CLOUD_CHECKOUT, live: `${CLOUD_CHECKOUT}/${part}`, remote: CLOUD_GIT_URL, dir: part };
}

/** One line of whombat-cloud's `infra/hetzner/deploy.sh plan <rev>`: what a deploy of that commit does to a part. */
export interface CloudPlanPart {
  part: CloudPart;
  /**
   * `deploy`: the part's folder differs from the build that runs (or that build can't be compared); `keep`: it is the
   * same, the build stays; `same`: production already runs this commit's.
   */
  verdict: 'deploy' | 'keep' | 'same';
  /** The build that runs: its commit, or `none`. */
  live: string;
  why: string;
}

/** `deploy.sh plan`'s output (`<part> <verdict> <live> <why…>`, one line a part), both parts or an error. */
export function parseCloudPlan(out: string): CloudPlanPart[] {
  const parts: CloudPlanPart[] = [];
  for (const line of out.split('\n')) {
    const m = /^(control|relay) (deploy|keep|same) (\S+) (.+)$/.exec(line.trim());
    if (m)
      parts.push({
        part: m[1] as CloudPart,
        verdict: m[2] as CloudPlanPart['verdict'],
        live: m[3] as string,
        why: (m[4] as string).trim(),
      });
  }
  const missing = CLOUD_PARTS.filter((p) => parts.filter((x) => x.part === p).length !== 1);
  if (missing.length)
    throw new Error(
      `deploy.sh plan said nothing usable about ${missing.join(' and ')}: ${out.trim().slice(0, 300) || '(no output)'}`,
    );
  return CLOUD_PARTS.map((p) => parts.find((x) => x.part === p) as CloudPlanPart);
}

/**
 * The parts a candidate pins at the whombat-cloud commit: the ones it deploys, and the ones production already runs
 * from that commit (a run that stopped after deploying them). A part whose folder didn't change keeps its pin: the
 * pins say what production runs.
 */
export const cloudPinned = (plan: readonly CloudPlanPart[]): CloudPart[] =>
  plan.filter((p) => p.verdict !== 'keep').map((p) => p.part);

/** The commit a candidate pins for a component, or null when it has none. */
export function pinnedCommit(m: CandidateManifest, id: string): string | null {
  return m.components.find((c) => c.id === id)?.commit ?? null;
}

/**
 * The next candidate from the previous one, as the hand-made ones were (IN-288…IN-295): the next rc of today, the
 * runtime at `whombatRev`, the app (and contracts, when they moved) at their tags, the hosts service at `hostsRev` when
 * given (IN-314); every other component unchanged.
 */
export function nextManifest(prev: CandidateManifest, pins: Pins, now: Date): CandidateManifest {
  const d: CandidateManifest = structuredClone(prev);
  const rc = Number(prev.productVersion.split('-rc.')[1]);
  if (!Number.isInteger(rc)) throw new Error(`productVersion ${prev.productVersion} has no -rc.N`);
  const day = utcDay(now, '.');
  d.productVersion = `${day}-rc.${rc + 1}`;
  d.tuple.releaseId = `rt-${day}-rc.${rc + 1}`;
  d.updatedAt = Math.floor(now.getTime() / 1000);
  const find = (id: string) => {
    const c = d.components.find((x) => x.id === id);
    if (!c) throw new Error(`the candidate has no ${id} component`);
    return c;
  };
  const runtime = find('whombat-runtime');
  runtime.commit = pins.whombatRev;
  if (pins.app.inWhombat) {
    // The app is the runtime's commit: the same checkout, and the runtime's `pnpm check` gate covers its packages. Its
    // builds stay (the hosted UI, the embed, the operator panel), without the vendored contracts' checksum step, which
    // the runtime loses too.
    runtime.build = withoutContractsVerify(runtime.build);
    const app = find('whombat-app');
    Object.assign(app, inWhombat(runtime), {
      ref: 'main',
      commit: pins.whombatRev,
      version: pins.app.version,
      build: withoutContractsVerify(app.build),
      gates: [],
    });
    if (pins.app.hasAdmin === false) Object.assign(app, withoutAdmin(app));
    delete app.tag;
  } else
    Object.assign(find('whombat-app'), {
      ref: `app-v${pins.app.version}`,
      commit: pins.app.commit,
      tag: `app-v${pins.app.version}`,
      version: pins.app.version,
    });
  if (pins.hostsRev) find('whombat-hosts').commit = pins.hostsRev;
  for (const part of pins.cloud?.parts ?? [])
    Object.assign(find(CLOUD_COMPONENT[part]), inCloud(part), { commit: pins.cloud?.rev });
  if (pins.contracts?.inWhombat && pins.contracts.version !== prev.contracts.version) {
    const c = find(prev.contracts.component);
    d.components[d.components.indexOf(c)] = contractsInWhombat(
      runtime,
      pins.contracts.version,
      pins.contracts.commit,
    );
    d.contracts.version = pins.contracts.version;
  } else if (pins.contracts && pins.contracts.version !== prev.contracts.version) {
    const c = find(prev.contracts.component);
    const old = prev.contracts.version;
    const moved = JSON.parse(
      JSON.stringify(c).replaceAll(`dist-release/${old}/`, `dist-release/${pins.contracts.version}/`),
    ) as Component;
    Object.assign(moved, {
      ref: `contracts-v${pins.contracts.version}`,
      commit: pins.contracts.commit,
      tag: `contracts-v${pins.contracts.version}`,
      version: pins.contracts.version,
    });
    d.components[d.components.indexOf(c)] = moved;
    d.contracts.version = pins.contracts.version;
  }
  return d;
}

/** The contracts version Whombat's root package.json vendors (`file:vendor/whombat-contracts/<v>/…`). */
export function vendoredContracts(packageJson: string): string {
  const deps = (JSON.parse(packageJson) as { dependencies?: Record<string, string> }).dependencies ?? {};
  const m = /^file:vendor\/whombat-contracts\/(\d+\.\d+\.\d+)\//.exec(deps['@whombat/core'] ?? '');
  if (!m?.[1]) throw new Error('Whombat’s package.json has no vendored @whombat/core');
  return m[1];
}

/**
 * The contracts version of a Whombat commit: its own packages/core (`corePackageJson`, since the contracts moved into
 * Whombat), or the release its root package.json vendors before that.
 */
export function contractsAt(packageJson: string, corePackageJson: string | null): string {
  if (corePackageJson === null) return vendoredContracts(packageJson);
  const v = (JSON.parse(corePackageJson) as { version?: string }).version ?? '';
  if (!semver(v))
    throw new Error(`Whombat’s packages/core/package.json has no x.y.z version (${v || 'none'})`);
  return v;
}

/** The app version of a Whombat commit's own apps/web/package.json (the app's one version, what app-vX.Y.Z tags). */
export function appVersionAt(webPackageJson: string): string {
  const v = (JSON.parse(webPackageJson) as { version?: string }).version ?? '';
  if (!semver(v)) throw new Error(`Whombat’s apps/web/package.json has no x.y.z version (${v || 'none'})`);
  return v;
}

/** A component's place when it lives in the Whombat repository: the runtime's checkout and remote. */
function inWhombat(runtime: Component): Pick<Component, 'repository' | 'source' | 'live' | 'remote'> {
  return {
    repository: 'Whombat',
    source: runtime.source,
    live: runtime.live as string | undefined,
    remote: runtime.remote as string | undefined,
  };
}

/** Build steps without `pnpm contracts:verify`, which nothing in Whombat has once it holds the contracts. */
function withoutContractsVerify(build: unknown): unknown {
  if (!Array.isArray(build)) return build;
  return build.filter((step) => {
    const run = (step as { run?: unknown }).run;
    return !(Array.isArray(run) && run.join(' ') === 'pnpm contracts:verify');
  });
}

/** The app's builds and artifacts without the operator panel's, which control builds and deploys itself. */
function withoutAdmin(app: Component): Pick<Component, 'build' | 'artifacts'> {
  const build = Array.isArray(app.build)
    ? app.build.filter((step) => {
        const run = (step as { run?: unknown }).run;
        return !(Array.isArray(run) && run.join(' ') === 'pnpm build:admin');
      })
    : app.build;
  const artifacts = Array.isArray(app.artifacts)
    ? app.artifacts.filter((a) => (a as { name?: unknown }).name !== 'whombat-app/admin')
    : app.artifacts;
  return { build, artifacts };
}

/**
 * The contracts component once they are released from Whombat (`pnpm contracts:release`): rebuilt from the tag in a
 * clean clone and compared with the release consumers vendor, with the Go module's tests and the generated files'
 * check (the runtime's `pnpm check` gate covers their TypeScript).
 */
export function contractsInWhombat(runtime: Component, version: string, commit: string): Component {
  const sums = `dist-release/contracts/${version}/SHA256SUMS`;
  const step = (run: string[], timeoutS = 1800) => ({ run, cwd: '.', env: {}, timeoutS });
  const gate = (id: string, run: string[]) => ({ ...step(run, 900), id, needsPostgres: false });
  return {
    id: 'whombat-contracts',
    ...inWhombat(runtime),
    ref: `contracts-v${version}`,
    commit,
    tag: `contracts-v${version}`,
    version,
    build: [
      step(['pnpm', 'install', '--frozen-lockfile']),
      step(['pnpm', 'contracts:release', '--skip-check']),
    ],
    artifacts: [
      {
        name: 'whombat-contracts',
        kind: 'tarball',
        from: { type: 'sums', path: sums, compareWith: `${runtime.source}/${sums}` },
        note: 'rebuilt from the tag in a clean clone and compared with the published SHA256SUMS that consumers vendor',
      },
    ],
    gates: [
      gate('go-test', ['pnpm', 'contracts:test:go']),
      gate('gen-check', ['pnpm', 'contracts:gen:check']),
    ],
    notes: [],
  };
}

/** nix/packages/runtime/default.nix: the candidate checks.runtime-pin compares with. */
export function setRuntimeCandidate(nix: string, version: string): string {
  const re = /^(\s*candidate = ")[^"]*(";)$/m;
  if (!re.test(nix)) throw new Error('nix/packages/runtime/default.nix has no `candidate = "…";`');
  return nix.replace(re, `$1${version}$2`);
}

const HASH_RE = /^(\s*pinnedPnpmDepsHash = ")[^"]*(";)$/m;

/**
 * The pinned pnpm store hash, with its comment saying where it comes from (the comment is the lines starting with `#`
 * right above it). `hash` "" makes Nix report the real one (the file's own instruction).
 */
export function setPnpmDepsHash(nix: string, hash: string, comment?: readonly string[]): string {
  if (!HASH_RE.test(nix)) throw new Error('nix/packages/runtime/default.nix has no pinnedPnpmDepsHash');
  let out = nix.replace(HASH_RE, `$1${hash}$2`);
  if (comment) {
    const lines = out.split('\n');
    const at = lines.findIndex((l) => HASH_RE.test(l));
    let top = at;
    while (top > 0 && /^\s*#/.test(lines[top - 1] as string)) top--;
    const indent = /^(\s*)/.exec(lines[at] as string)?.[1] ?? '';
    lines.splice(top, at - top, ...comment.map((c) => `${indent}# ${c}`));
    out = lines.join('\n');
  }
  return out;
}

/** `lib.fakeHash`: a fixed-output hash no store path has, so Nix builds it and reports the real one. */
export const FAKE_HASH = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const VENDOR_RE = /^(\s*vendorHash = ")[^"]*(";)$/m;

/**
 * nix/packages/hosts/default.nix: the hash of whombat-hosts' vendored Go modules. A new go.mod/go.sum needs
 * {@link FAKE_HASH} first (the file's own instruction), then the hash Nix reports; its comment stays.
 */
export function setVendorHash(nix: string, hash: string): string {
  if (!VENDOR_RE.test(nix)) throw new Error('nix/packages/hosts/default.nix has no `vendorHash = "…";`');
  return nix.replace(VENDOR_RE, `$1${hash}$2`);
}

/** The hash a fixed-output build reports when its pinned one is wrong or empty. */
export function reportedHash(nixOutput: string): string | null {
  return /got:\s+(sha256-[A-Za-z0-9+/]+=*)/.exec(nixOutput)?.[1] ?? null;
}

const rowNumber = (line: string) => {
  const m = /^\| IN-(\d+) \|/.exec(line);
  return m ? Number(m[1]) : null;
};

/**
 * The next free `IN-nn` in docs/decisions/integration.md: counting up from its first row, the first number no row has.
 * Rows are never removed, so that is the highest plus one, unless a row was written ahead of a number kept for a
 * candidate (IN-314 before the release IN-313): the candidate then takes the kept one.
 */
export function nextDecision(md: string): number {
  const taken = new Set<number>();
  for (const m of md.matchAll(/^\| IN-(\d+) \|/gm)) taken.add(Number(m[1]));
  if (!taken.size) throw new Error('integration.md has no IN rows');
  let n = Math.min(...taken);
  while (taken.has(n)) n++;
  return n;
}

/** The decision a candidate was made under (its row starts `| IN-nn | **Candidate <version>:`), if any. */
export function decisionFor(md: string, version: string): number | null {
  const v = version.replaceAll('.', '\\.');
  const m = new RegExp(`^\\| IN-(\\d+) \\| \\*\\*Candidate ${v}:`, 'm').exec(md);
  return m ? Number(m[1]) : null;
}

/**
 * One more row in the decisions table (the file ends with the table): at the end, or before the first row with a
 * higher number (a kept number taken after a later row, {@link nextDecision}), so the table stays in order.
 */
export function appendRow(md: string, row: string): string {
  const n = rowNumber(row);
  const lines = md.replace(/\n*$/, '').split('\n');
  const at = n === null ? -1 : lines.findIndex((l) => (rowNumber(l) ?? 0) > n);
  if (at < 0) return `${lines.join('\n')}\n${row}\n`;
  lines.splice(at, 0, row);
  return `${lines.join('\n')}\n`;
}

/** Words wrapped at `width` (the runbooks' 120 columns). */
export function wrap(text: string, width = 120): string {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + w.length > width) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.join('\n');
}

/**
 * The next release id of today (`whombat-YYYYMMDD.N`, PI-23, ONE-04) after the ones in `existing` (built here,
 * published): boxes and the GitHub repository order `whombat-` and `whombat-dev-` ids as one family by day and number
 * (LNK-22), so N is above every id of either of today; a `whombat-dev-YYYYMMDD.N` of the same N would be the same
 * release to a box.
 */
export function nextProdId(existing: readonly string[], now: Date): string {
  const day = utcDay(now, '');
  let n = 0;
  for (const id of existing) {
    const m = /^whombat-(?:dev-)?(\d{8})\.(\d+)$/.exec(id);
    if (m?.[1] === day) n = Math.max(n, Number(m[2]));
  }
  return `whombat-${day}.${n + 1}`;
}

/** A release build kept here (~/.cache/whombat-releases/whombat-* or pve-*): its image, Whombat, host and candidate. */
export interface BuiltRelease {
  id: string;
  /** The image's environment (`prod`: the one Whombat image since ONE-02, and the Hetzner image before it). */
  env?: string | null;
  /** The DEV twin built beside it before ONE-02; null since. */
  twin: string | null;
  whombatRev: string | null;
  /** The host it runs: its own id for a host release, the reused one's for a runtime-only release. */
  host: string | null;
  /** The candidate it was built from (`ship.candidate.name`). */
  candidate: string | null;
  /** The appliance commit it was built from (`source.rev`). */
  sourceRev?: string | null;
}

/**
 * Whether a host built from an appliance commit is the one Whombat image (ONE-02): its `nix/profiles/prod-instance.nix`
 * sets the helper's default channel (the GitHub repository's channels). The Hetzner image before it, of the same `prod`
 * environment, has none and reads another repository, so its host is never reused.
 */
export function isOneImage(prodProfileNix: string | null): boolean {
  return (prodProfileNix ?? '')
    .split('\n')
    .some((l) => /^\s*whombat\.helper\.defaultChannel\s*=\s*"/.test(l));
}

/** The newest release among the Beta channel's `ids` (one family, LNK-22, ONE-04): what Beta boxes take. */
export function newestOnBeta(ids: Iterable<string>): string | null {
  let best: ReturnType<typeof parseReleaseId> = null;
  for (const id of ids) {
    const r = parseReleaseId(id);
    if (r && (!best || compareIds(r, best) > 0)) best = r;
  }
  return best?.id ?? null;
}

/**
 * Beta's newest release when it is a build of the one Whombat image here (ONE-02), and the build of its host (itself
 * for a host release): what a runtime-only release reuses. A DEV twin from before ONE-02, or a release built
 * elsewhere, has none, and the candidate builds a host release. The host's candidate pins the hub that release carries
 * (`checks.hosts-pin`, NX-152).
 */
export function betaBuilds(
  builds: readonly BuiltRelease[],
  newest: string | null,
): { on: BuiltRelease | null; host: BuiltRelease | null } {
  const on = newest ? (builds.find((b) => b.id === newest && b.env === 'prod') ?? null) : null;
  return { on, host: hostBuildFor(builds, on?.host ?? null) };
}

/** The actual host of a selected release, including when --reuse-host names a runtime-only release. */
export function hostBuildFor(builds: readonly BuiltRelease[], id: string | null): BuiltRelease | null {
  const release = builds.find((b) => b.id === id);
  return release?.host ? (builds.find((b) => b.id === release.host) ?? null) : null;
}

/** A host release: its host is its own (`--host`); a runtime-only one names the host it reused. */
export const isHostRelease = (b: BuiltRelease) => b.host === b.id;

/** What a run wrote once its release was in Beta (`rel-<version>/published.json`), or null. */
export function publishedRelease(json: string | null): { release: string } | null {
  if (!json) return null;
  try {
    const r = (JSON.parse(json) as { release?: unknown }).release;
    return typeof r === 'string' && parseReleaseId(r) ? { release: r } : null;
  } catch {
    return null;
  }
}

/**
 * The build of the previous candidate that is out already (IN-377): its run put `published` in Beta (its
 * `published.json`), and that release was built here from candidate `version` at Whombat `rev`, as a host release when
 * the run needs one (`--host`, `--hosts`). Then a run for the same commits has nothing to ship; without it, a candidate
 * that pins them ({@link resumes}) carries on. Null when nothing of it is out.
 */
export function shippedBuild(
  builds: readonly BuiltRelease[],
  version: string,
  rev: string,
  needsHost: boolean,
  published: { release: string } | null,
): BuiltRelease | null {
  const b = published ? builds.find((x) => x.id === published.release) : undefined;
  if (!b || b.candidate !== version || b.whombatRev !== rev) return null;
  return needsHost && !isHostRelease(b) ? null : b;
}

/**
 * Whether the previous candidate is this run's, merged by a run that stopped after it: it pins Whombat `rev` and,
 * with `--hosts`, the hosts service at `hostsRev`, and with `--cloud` the whombat-cloud commit for every part that moves to
 * it (`cloud.parts`, {@link cloudPinned}). Then the run carries on from the release build, unless that candidate's
 * release is out already ({@link shippedBuild}). An explicit different `--version` starts a new candidate, including
 * for an appliance-only `--host` change with the same runtime.
 */
export function resumes(
  prev: CandidateManifest,
  rev: string,
  hostsRev: string | null,
  cloud: { rev: string; parts: readonly CloudPart[] } | null = null,
  version: { previous: string; requested: string | null } | null = null,
): boolean {
  return (
    (!version?.requested || version.requested === version.previous) &&
    pinnedCommit(prev, 'whombat-runtime') === rev &&
    (hostsRev === null || pinnedCommit(prev, 'whombat-hosts') === hostsRev) &&
    (cloud?.parts ?? []).every((part) => pinnedCommit(prev, CLOUD_COMPONENT[part]) === cloud?.rev)
  );
}

/**
 * Without `--hosts`: the whombat-hosts commit the candidate keeps when Beta's newest release carries another hub (a
 * `--hosts` run that stopped after its merge, or a hand-made candidate). A runtime-only release on that host would
 * leave the boxes on the old hub while the candidate names the new one, so the run asks for `--hosts` instead. Null
 * when they agree or aren't known.
 */
export function hubBehind(
  candidateHosts: string | null,
  releaseHosts: string | null,
  hostsRev: string | null,
): string | null {
  if (hostsRev || !candidateHosts || !releaseHosts || candidateHosts === releaseHosts) return null;
  return candidateHosts;
}

/**
 * `release/ship build`'s arguments: runtime-only on the host of Beta's newest release (`--reuse-host`), or a host
 * release when the hosts service moves or the image changed (`reuse` null; the hub is in the image, NX-152, NX-523).
 */
export function shipBuildArgs(id: string, reuse: string | null): string[] {
  return ['build', id, ...(reuse ? ['--reuse-host', reuse] : ['--host'])];
}

/** The hosts service moving with the candidate (`--hosts`, IN-314). */
export interface HostsMove {
  rev: string;
  /** Its commit's subject. */
  subject: string;
  /** Whether its go.mod/go.sum moved (a new `vendorHash`). */
  vendorMoved: boolean;
  /** The fingerprint of the key its agents were signed with (`dev/sign-agents`, NX-158); absent when carried on. */
  agentKey?: string;
}

/** The checks step 1 builds: the pins (NX-42, NX-152) and the signed agents' manifest (NX-158). */
export const PIN_CHECKS = ['runtime-pin', 'hosts-pin', 'hosts-agent-manifest'] as const;

const AGENT_FILES = ['whombat-agent-linux-amd64', 'whombat-agent-linux-arm64'];
/** What a pin with Macs (NX-515) signs besides: both macOS agents and Whombat Helper's zip. */
const MAC_FILES = ['whombat-agent-darwin-amd64', 'whombat-agent-darwin-arm64', 'whombat-helper-macos.zip'];
/** What a pin with Windows PCs (Whombat windows-servers.md) signs besides: both Windows agents. */
const WINDOWS_FILES = ['whombat-agent-windows-amd64.exe', 'whombat-agent-windows-arm64.exe'];

/**
 * What `dev/sign-agents` wrote to nix/packages/hosts/agent-manifest.json (rackoon-sign's manifest, NX-158): the agents'
 * version and the key's fingerprint, refused when it isn't for whombat-hosts `rev` (its version ends in the short rev,
 * nix/packages/hosts/default.nix) or doesn't sign both Linux agents (and both macOS agents when it signs one; the
 * Whombat Helper's zip may be there too; both Windows agents when it signs one). The build checks the sums and
 * signatures.
 */
export function signedAgents(manifestJson: string, rev: string): { version: string; key: string } {
  const m = JSON.parse(manifestJson) as { version?: unknown; key?: unknown; files?: Record<string, unknown> };
  const short = rev.slice(0, 7);
  if (typeof m.version !== 'string' || !m.version.endsWith(`.${short}`))
    throw new Error(
      `the agent manifest is for ${String(m.version)}, not the hosts service at ${short}: run dev/sign-agents`,
    );
  if (typeof m.key !== 'string' || !/^[0-9a-f]{16}$/.test(m.key))
    throw new Error(`the agent manifest has no key fingerprint (${String(m.key)}): run dev/sign-agents`);
  const files = Object.keys(m.files ?? {}).sort();
  const macAgents = files.filter((f) => f.startsWith('whombat-agent-darwin-'));
  const windowsAgents = files.filter((f) => f.startsWith('whombat-agent-windows-'));
  if (
    !AGENT_FILES.every((f) => files.includes(f)) ||
    files.some((f) => !AGENT_FILES.includes(f) && !MAC_FILES.includes(f) && !WINDOWS_FILES.includes(f)) ||
    (macAgents.length > 0 && macAgents.length !== 2) ||
    (windowsAgents.length > 0 && windowsAgents.length !== 2)
  )
    throw new Error(
      `the agent manifest signs ${files.join(', ') || 'nothing'}, not both agents: run dev/sign-agents`,
    );
  return { version: m.version, key: m.key };
}

/**
 * The repository-wide rules of the guard list (under its “repository-wide” heading, to the next blank line), as
 * scripts/check-forbidden.sh reads them: texts this repository must never hold again.
 */
export function repositoryForbidden(publicForbid: string): RegExp[] {
  const rules: RegExp[] = [];
  let on = false;
  for (const line of publicForbid.split('\n')) {
    if (line.startsWith('# repository-wide')) on = true;
    else if (on && line === '') on = false;
    else if (on && line.startsWith('regex:')) {
      const rule = line.slice('regex:'.length);
      rules.push(rule.startsWith('(?i)') ? new RegExp(rule.slice(4), 'i') : new RegExp(rule));
    }
  }
  return rules;
}

/**
 * A commit's subject as a candidate quotes it, or '' when it holds a text the repository must never hold: another
 * repository's history may still name it, and quoting it would put it into this one's docs.
 */
export const fitSubject = (subject: string, forbidden: readonly RegExp[]) =>
  forbidden.some((r) => r.test(subject)) ? '' : subject;

/** ` (“subject”)` after a commit, or nothing when the subject was left out ({@link fitSubject}). */
const quoted = (subject: string) => (subject ? ` (“${subject.replace(/\|/g, '/')}”)` : '');

const hostsShort = (h: HostsMove) => h.rev.slice(0, 7);
/** “the hosts service at `abc1234` (“subject”)”: which hosts commit a candidate carried. */
export const hostsCarried = (h: HostsMove) => `the hosts service at \`${hostsShort(h)}\`${quoted(h.subject)}`;
/** Control when it moved with the candidate (`--cloud`): the whombat-cloud commit and its subject. */
export interface ApiMove {
  rev: string;
  subject: string;
}
/** “control at whombat-cloud `abc1234` (“subject”)”: which commit's control a candidate carried. */
export const apiCarried = (c: ApiMove) =>
  `control at whombat-cloud \`${c.rev.slice(0, 7)}\`${quoted(c.subject)}`;
/** The relay when it moved with the candidate (`--cloud`): the whombat-cloud commit and its subject. */
export type RelayMove = ApiMove;
/** “the relay at whombat-cloud `abc1234` (“subject”)”: which commit's relay a candidate carried. */
export const relayCarried = (c: RelayMove) =>
  `the relay at whombat-cloud \`${c.rev.slice(0, 7)}\`${quoted(c.subject)}`;
/** The components a candidate left as they were. */
export const unchanged = (
  h: HostsMove | null,
  api: ApiMove | null = null,
  relay: RelayMove | null = null,
) => {
  const left = [
    ...(api ? [] : ['control']),
    ...(relay ? [] : ['relay']),
    'manager',
    ...(h ? [] : ['the hosts service']),
  ];
  if (left.length === 1) return `${left[0]} unchanged`;
  return `${left.slice(0, -1).join(', ')} and ${left[left.length - 1]} unchanged`;
};

export interface RowFacts {
  decision: number;
  version: string;
  what: string;
  why: string;
  whombat: { short: string; subject: string };
  app: { version: string; commit: string; inWhombat?: boolean };
  contracts: { version: string; previous: string };
  lockfileMoved: boolean;
  hosts: HostsMove | null;
  api?: ApiMove | null;
  relay?: RelayMove | null;
}

/** The candidate's row in docs/decisions/integration.md. */
export function candidateRow(f: RowFacts): string {
  const moved = f.contracts.version !== f.contracts.previous;
  return [
    `| IN-${f.decision} | **Candidate ${f.version}: ${f.what}.**`,
    f.why ? `${f.why}` : '',
    f.app.inWhombat
      ? `Whombat \`${f.whombat.short}\`${quoted(f.whombat.subject)} with its app ${f.app.version};`
      : `Whombat \`${f.whombat.short}\`${quoted(f.whombat.subject)}, the app \`app-v${f.app.version}\` (\`${f.app.commit.slice(0, 8)}\`);`,
    moved
      ? `contracts ${f.contracts.version} (was ${f.contracts.previous});`
      : `contracts ${f.contracts.version} unchanged;`,
    f.lockfileMoved ? 'a new `pnpmDeps` hash;' : '`pnpmDeps` hash unchanged (the same lockfile);',
    f.hosts
      ? `${hostsCarried(f.hosts)}, ${f.hosts.vendorMoved ? 'a new `vendorHash`' : '`vendorHash` unchanged (the same go.mod and go.sum)'}${f.hosts.agentKey ? `, its agents signed with key \`${f.hosts.agentKey}\` (\`dev/sign-agents\`, NX-158)` : ''};`
      : '',
    f.api ? `${apiCarried(f.api)};` : '',
    f.relay ? `${relayCarried(f.relay)};` : '',
    f.hosts
      ? `${unchanged(f.hosts, f.api ?? null, f.relay ?? null)}; a host release (\`--host\`, NX-152: the hub is in the image). Made by whombat-ops \`candidate\`: \`nix build .#whombat-runtime .#whombat-hosts\`,`
      : `${unchanged(null, f.api ?? null, f.relay ?? null)}. Made by whombat-ops \`candidate\`: \`nix build .#whombat-runtime\`,`,
    `${PIN_CHECKS.map((c) => `\`checks.${c}\``).join(', ')}; no validation (IN-132). Published to Beta; Production only by \`promote\` (ONE-19).`,
    `| ${f.why || f.what} |`,
  ]
    .filter(Boolean)
    .join(' ');
}

export interface SectionFacts {
  version: string;
  day: string;
  /** The candidate it started from, or null when it carried on with one already merged. */
  previous: string | null;
  decision: number;
  what: string;
  why?: string;
  whombatShort: string;
  app: string;
  /** The app is the Whombat commit's own (since whombat-app moved into Whombat). */
  appInWhombat?: boolean;
  contracts: string;
  contractsMoved: boolean;
  lockfileMoved: boolean;
  hosts: HostsMove | null;
  total: string;
  releaseId: string;
  /** The release build (`whombat-YYYYMMDD.N`), what Beta publishes. */
  build: string;
  /** The host reused (`--reuse-host`), or null for a host release (`--host`). */
  reuse: string | null;
  /** The hosted parts deployed to production on the way ({@link hostedPlan}), in order. */
  hosted?: readonly HostedDeploy[];
  api?: ApiMove | null;
  relay?: RelayMove | null;
}

/** Who takes a Beta release, and when (ONE-19): the words of the runbook, the summary and the output. */
export const TAKEN_BY = 'Beta, which every Beta Whombat (Home among them) takes within the hour';

/** The app a section names: Whombat's own (`appInWhombat`), or the release it vendors at its tag. */
const appWords = (f: { app: string; appInWhombat?: boolean }) =>
  f.appInWhombat ? `its app ${f.app}` : `the app at \`app-v${f.app}\``;

/** “control at `abc1234`, the web and the embed at Whombat `def5678`”: the hosted deploys in words. */
export function hostedWords(hosted: readonly HostedDeploy[] | undefined): string {
  if (!hosted?.length) return 'nothing hosted deployed (control, relay and the account site as they were)';
  return `deployed to production with whombat-cloud's \`deploy.sh\` (a database dump first, the previous build kept, ONE-18): ${hosted
    .map((h) => `${h.part} at \`${h.ref.slice(0, 12)}\``)
    .join(', ')}`;
}

/** The releases runbook's section for a candidate (whombat-ops runbooks/appliance/releases.md), wrapped. */
export function runbookSection(f: SectionFacts): string {
  const rel = `~/.cache/wb-tmp/rel-${f.version}/`;
  const head = f.hosts
    ? `with Whombat \`${f.whombatShort}\`, ${appWords(f)} and ${hostsCarried(f.hosts)}: ${f.what}.`
    : `with Whombat \`${f.whombatShort}\` and ${appWords(f)}: ${f.what}.`;
  const build = f.reuse
    ? `\`release/ship build ${f.build} --reuse-host ${f.reuse}\`;`
    : `a host release, \`release/ship build ${f.build} --host\`;`;
  return [
    `### ${f.build}: candidate ${f.version} (${f.day})`,
    '',
    wrap(
      [
        `${f.previous ?? 'The candidate'} ${head}${f.why ? ` ${f.why}` : ''} IN-${f.decision}.`,
        f.contractsMoved ? `Contracts ${f.contracts}` : `Contracts ${f.contracts} unchanged`,
        `and the \`pnpmDeps\` hash ${f.lockfileMoved ? 'new' : 'unchanged'};${f.api ? ` ${apiCarried(f.api)};` : ''}${f.relay ? ` ${relayCarried(f.relay)};` : ''} ${unchanged(f.hosts, f.api ?? null, f.relay ?? null)}.`,
        `Done with whombat-ops \`candidate\` in ${f.total} (\`${rel}\`): the runtime \`${f.releaseId}\`;`,
        build,
        `${hostedWords(f.hosted)};`,
        `\`${f.build}\` published in ${TAKEN_BY}. Production: \`promote ${f.build} --yes\`, on John's word.`,
      ].join(' '),
    ),
  ].join('\n');
}

/** The releases runbook's start, when a candidate finds none (whombat-ops runbooks/appliance/releases.md). */
export const RELEASES_RUNBOOK_HEAD = `# Releases

What each candidate put in Beta and on production, newest last (written by \`candidate\`; ONE-19). Production gets a
release only with \`promote <id> --yes\`, on John's word (shipping.md).
`;

/** The releases runbook with one more section, at its end (the newest last). */
export function appendSection(md: string, section: string): string {
  return `${md.replace(/\n*$/, '\n')}\n${section.trim()}\n`;
}

/** The summary's second line: what the candidate carried. */
export function summaryCarried(f: {
  whombatShort: string;
  app: string;
  contracts: string;
  hosts: HostsMove | null;
  decision: number;
}): string {
  const hosts = f.hosts ? `, the hosts service at ${hostsShort(f.hosts)} (a host release)` : '';
  return `Whombat ${f.whombatShort}, app ${f.app}, contracts ${f.contracts}${hosts}; IN-${f.decision}`;
}

/** The environment the Beta publish needs: the publisher's clone of whombat-releases and its token. */
export const RELEASES_DIR_ENV = 'WHOMBAT_RELEASES_DIR';
export const RELEASES_TOKEN_ENV = 'WHOMBAT_RELEASES_TOKEN';

/**
 * Where a candidate's release goes (ONE-19): the Beta channel of the GitHub repository, through the publisher's clone
 * and token from the environment. A missing one is an error before anything starts: every box reads only that
 * repository (LNK-50, ONE-02).
 */
export function releasesTarget(env: Readonly<Record<string, string | undefined>>): { dir: string } {
  const dir = env[RELEASES_DIR_ENV];
  if (!dir || !env[RELEASES_TOKEN_ENV])
    throw new Error(
      `the release goes to Beta, on GitHub: it needs ${RELEASES_DIR_ENV} (the publisher's clone of whombat-releases) and ${RELEASES_TOKEN_ENV} (its token); whombat-ops bin/candidate reads both from ~/.config/whombat/releases.env`,
    );
  return { dir };
}

/**
 * The candidate freeze: while the file exists, a candidate refuses to run (a dry run still does). Someone sets it with
 * `candidate --freeze "<why>"` when nothing may reach Beta for a while (the key ceremony, a move), and lifts it with
 * `rm`.
 */
export const FREEZE_ENV = 'WHOMBAT_CANDIDATE_FREEZE';
export const freezeFile = (env: Readonly<Record<string, string | undefined>>, home: string) =>
  env[FREEZE_ENV] || `${home}/.config/whombat/candidate-freeze`;

/** What a frozen candidate says: why (the file's first line), and how to lift it. */
export function freezeMessage(file: string, contents: string): string {
  const why = contents.split('\n')[0]?.trim() || 'no reason given';
  return `candidates are frozen (${why}): nothing goes to Beta until it is lifted, with: rm ${file}`;
}

/** `tufrepo gh-publish`'s arguments: the release directory into the Beta channel (`development`, LNK-24, ONE-03). */
export function githubPublishArgs(releasesDir: string, releaseDir: string): string[] {
  return ['gh-publish', '--dir', releasesDir, '--release-dir', releaseDir];
}

/**
 * The MemoryHigh of the user scope a command of the candidate runs in (lib/proc.ts `memoryHigh`): the dentries and
 * page cache it leaves (tar of the stack's home, git's and nix's fetches, pnpm's store, ship's builds) are reclaimed
 * there rather than kept until the host runs short, pinning ZFS ARC metadata on the build machine. Each cap is above what the
 * command needs itself (2026-10-22: nix evaluating checks.runtime-pin 1.5 GiB, a NixOS system 1.7 GiB, pnpm install
 * 0.4 GiB; ship evaluates two systems side by side). Null for what works elsewhere: docker exec in its container,
 * systemctl in its unit, dev/status. WB_MEMORY_HIGH_FILES, _BUILD and _SHIP override the caps;
 * WB_MEMORY_SCOPE=0 runs every command as it is.
 */
export function memoryHighFor(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const name = cmd.split('/').at(-1) ?? cmd;
  if (name === 'tar' || name === 'git') return env.WB_MEMORY_HIGH_FILES || '1G';
  if (['nix', 'pnpm', 'node', 'sign-agents'].includes(name)) return env.WB_MEMORY_HIGH_BUILD || '4G';
  if (name === 'ship') return env.WB_MEMORY_HIGH_SHIP || '8G';
  return null;
}

/** Build the bundle release/ship will use, together with every pin check, in one evaluation. */
export function candidateBuildArgs(worktree: string, hosts: boolean): string[] {
  const flake = JSON.stringify(`git+file://${worktree}`).replaceAll('${', '\\${');
  const outputs = [
    '(f.lib.releaseRuntime f.packages.x86_64-linux.whombat-runtime null)',
    ...(hosts ? ['f.packages.x86_64-linux.whombat-hosts'] : []),
    ...PIN_CHECKS.map((c) => `f.checks.x86_64-linux.${c}`),
  ];
  return [
    'build',
    '--impure',
    '--no-link',
    '--print-out-paths',
    '-L',
    '--expr',
    `let f = builtins.getFlake ${flake}; in [ ${outputs.join(' ')} ]`,
  ];
}

/**
 * The release build a candidate run uses (`rel-<version>/chosen-build.json`): chosen once, before anything is built or
 * published, so a run that stopped after (Beta refused it, a hosted deploy failed) goes on with the same build id
 * rather than build another release.
 */
export interface ChosenBuild {
  id: string;
  /** The host it reuses, null for a host release. */
  reuse: string | null;
  /** The release directory, once built. */
  release?: { releaseId: string; dir: string };
}

/**
 * A `chosen-build.json` this candidate wrote, or null: one the DEV-era candidate wrote (it names a twin and a way of
 * rolling out) chose a DEV twin's build, which a run now must not carry on with.
 */
export function savedBuild(json: string): ChosenBuild | null {
  try {
    const b = JSON.parse(json) as ChosenBuild & { twin?: unknown; noRollout?: unknown };
    return typeof b.id === 'string' && !('twin' in b) && !('noRollout' in b) ? b : null;
  } catch {
    return null;
  }
}

export function buildForRun(
  saved: ChosenBuild | null,
  run: { resume: boolean; reuse: string | null },
  nextId: string,
): ChosenBuild {
  if (!run.resume || !saved) return { id: nextId, reuse: run.reuse };
  if (saved.reuse !== run.reuse)
    throw new Error(
      `this candidate's release ${saved.id} was started ${saved.reuse ? `on host ${saved.reuse}` : 'as a host release'}, this run would build ${run.reuse ? `on host ${run.reuse}` : 'a host release'}: run it again as it was started, or with a new --version`,
    );
  return saved;
}

/* The hosted parts on production (ONE-01, ONE-18, ONE-19) ------------------------------------------------------- */

/** What whombat-cloud's `infra/hetzner/deploy.sh` deploys, in the order a candidate deploys them. */
export type HostedPart = 'control' | 'relay' | 'web' | 'embed';
export const HOSTED_ORDER: readonly HostedPart[] = ['control', 'relay', 'web', 'embed'];

export interface HostedDeploy {
  part: HostedPart;
  /** The commit deployed: whombat-cloud's for control and the relay, Whombat's for the web and the embed. */
  ref: string;
  why: string;
}

/**
 * The Whombat paths the hosted web and embed are built from: the account site, the widget, the shared packages and the
 * workspace's lockfile. A Whombat commit that moved none of them since the deployed one needs no web deploy.
 */
export const WEB_PATHS = [
  'apps/web',
  'apps/widget',
  'packages',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'patches',
] as const;

/**
 * The Whombat commit production's account site was built from: `version.json`'s `build` (`<version>+<7-character
 * commit>`, apps/web/version-file.ts), or null when it says none.
 */
export function webBuildCommit(versionJson: string | null): string | null {
  if (!versionJson) return null;
  try {
    const build = (JSON.parse(versionJson) as { build?: unknown }).build;
    const m = typeof build === 'string' ? /\+([0-9a-f]{7,40})$/.exec(build) : null;
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the account site (and its embed) go to production with this candidate: `deployed` is the commit production's
 * web was built from (null: unknown), `changed` whether {@link WEB_PATHS} differ between it and `rev` (null: that commit
 * isn't in the checkout here). Unknown is a deploy: the hosted web must speak what the release does.
 */
export function webDecision(o: { deployed: string | null; rev: string; changed: boolean | null }): {
  deploy: boolean;
  why: string;
} {
  if (!o.deployed) return { deploy: true, why: "production's account site names no Whombat commit" };
  if (o.rev.startsWith(o.deployed))
    return { deploy: false, why: `production's account site is Whombat ${o.deployed}` };
  if (o.changed === null)
    return { deploy: true, why: `production's account site is Whombat ${o.deployed}, unknown here` };
  return o.changed
    ? { deploy: true, why: `the account site changed since Whombat ${o.deployed}, production's` }
    : { deploy: false, why: `the account site is the same as at Whombat ${o.deployed}, production's` };
}

/**
 * The hosted deploys of a candidate, in order (control first: P's rule that control speaks the new contracts with or
 * before the account site): with `--cloud`, control and the relay when `deploy.sh plan` says their folder changed
 * since the build that runs ({@link CloudPlanPart}); the web and the embed when {@link webDecision} says so. `done`
 * (rel-<version>/hosted.json) are the ones a stopped run already deployed.
 */
export function hostedPlan(o: {
  cloud: { rev: string; plan: readonly CloudPlanPart[] } | null;
  whombatRev: string;
  web: { deploy: boolean; why: string };
  done?: readonly HostedDeploy[];
}): HostedDeploy[] {
  const cloud = o.cloud;
  const all: HostedDeploy[] = [
    ...(cloud
      ? CLOUD_PARTS.flatMap((part) => {
          const p = cloud.plan.find((x) => x.part === part);
          return p?.verdict === 'deploy' ? [{ part, ref: cloud.rev, why: p.why }] : [];
        })
      : []),
    ...(o.web.deploy
      ? (['web', 'embed'] as const).map((part) => ({ part, ref: o.whombatRev, why: o.web.why }))
      : []),
  ];
  return all.filter((h) => !o.done?.some((d) => d.part === h.part && d.ref === h.ref));
}

/** `deploy.sh`'s arguments for one hosted part: the component and the full commit. */
export function deployArgs(h: HostedDeploy): string[] {
  return [h.part, h.ref];
}

/**
 * Whether control speaks what a candidate needs (R2 A11): the contracts of its Whombat commit, which the release's
 * runtime and the account site are built from. Control must be at least that version, or the site's and the boxes'
 * requests it doesn't know are refused (a 4.8.0 site's promotion code at a 4.7.0 control). `control` is the version of
 * the control that will answer: the `--cloud` commit's when control is deployed from it, or the one production runs
 * (`/v1/health`); null is unknown, which is refused too. Null back: it speaks it.
 */
export function controlSpeaks(o: { needed: string; control: string | null; from: string }): string | null {
  if (o.control && compareVersions(o.control, o.needed) >= 0) return null;
  const has = o.control ? `speaks contracts ${o.control}` : 'says no contracts version';
  return `${o.from} ${has}, older than the ${o.needed} this release and the account site are built with: nothing is deployed or published before control is (candidate --cloud <a whombat-cloud commit whose control vendors contracts ${o.needed} or later>)`;
}

/** The contracts version production control's `/v1/health` says it speaks, or null. */
export function healthContracts(json: string | null): string | null {
  if (!json) return null;
  try {
    const c = (JSON.parse(json) as { contracts?: unknown }).contracts;
    return typeof c === 'string' && /^\d+\.\d+\.\d+/.test(c) ? c : null;
  } catch {
    return null;
  }
}
