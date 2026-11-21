/**
 * `manifest/components.json`: the component list. It says what a release is made of and how each part is checked
 * (its build from a clean clone, the artifacts to digest, its gates), and names no commit. A release of the one
 * repository is one commit of it, so its pins are this list with that commit filled in; control and the relay, which
 * live in whombat-cloud, get the commits production runs with the release (the release records, below).
 *
 *   manifest/pins-at [<commit>] [--name N] [--cloud <whombat-cloud commit>] [--out FILE]
 *
 * writes the pins of a commit (default HEAD) as a file `WB_MGD_PINS` can name, and prints its path. The full
 * validation (`release/ship validate`) and the bill of materials (`release/sbom`) use it; a release from before the
 * one repository keeps the candidate manifest its own commit holds.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { opsDir } from '../lib/guards.ts';
import { expandHome, REPO_DIR, STATE_HOME } from '../lib/paths.ts';
import { type FindOptions, findSource, showAt } from '../lib/source.ts';
import { Artifact, Cmd, type Component, Gate, Pins, Placeholder } from './pins.ts';

/** Where a component's repository is: this one, or the private whombat-cloud (control and the relay). */
const Place = z.enum(['whombat', 'cloud']);
export type Place = z.infer<typeof Place>;

const Listed = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** The name the product manifest knows the component's code by (the contracts' `RepositoryName`). */
  repository: z.string(),
  in: Place,
  /** Its folder in that repository (`appliance`, `hosts`, `control`, `relay`); none for the repository's top. */
  dir: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  /** A fixed version, or the `package.json` (seen from the component's own folder) whose version it is. */
  version: z.string().optional(),
  versionFrom: z.string().optional(),
  build: z.array(Cmd).default([]),
  artifacts: z.array(Artifact).default([]),
  gates: z.array(Gate).default([]),
  notes: z.array(z.string()).default([]),
});

export const ComponentList = z.strictObject({
  $schema: z.literal('whombat.components/1'),
  components: z.array(Listed).min(1),
  tuple: Pins.shape.tuple.omit({ releaseId: true }),
  placeholders: z.array(Placeholder).default([]),
});
export type ComponentList = z.infer<typeof ComponentList>;

export const COMPONENTS_FILE = 'manifest/components.json';

/** The two parts of whombat-cloud a release runs against, by the list's component ids. */
export const CLOUD_IDS = { control: 'whombat-api', relay: 'whombat-relay' } as const;
export type CloudCommits = { control: string; relay: string };

export interface PinFacts {
  /** The release's commit: every component of this repository is built from it. */
  commit: string;
  /** That commit's time, in seconds: when these pins changed. */
  time: number;
  /** What names this set: the candidate's number, or the commit's short id. */
  name: string;
  /** Where each repository is on this machine. */
  sources: Record<Place, string>;
  /** whombat-cloud's commit for control and for the relay. */
  cloud: CloudCommits;
  /** A file of a repository at a commit (a `package.json` for a version). */
  read: (place: Place, commit: string, path: string) => string;
}

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * The pins of a commit: the list with the commit, each component's version and the machine's paths filled in.
 * `{contracts}` and `{app}` in a command, a path or a note stand for those versions at the commit, `{whombat}` and
 * `{cloud}` for the repositories' folders.
 */
export function pinsFor(list: ComponentList, f: PinFacts): Pins {
  for (const [what, rev] of [
    ['the commit', f.commit],
    ['whombat-cloud’s commit for control', f.cloud.control],
    ['whombat-cloud’s commit for the relay', f.cloud.relay],
  ] as const)
    if (!COMMIT.test(rev)) throw new Error(`${what} must be a full commit id, not ${rev || 'nothing'}`);
  const commitOf = (c: z.infer<typeof Listed>): string =>
    c.in === 'whombat' ? f.commit : c.id === CLOUD_IDS.relay ? f.cloud.relay : f.cloud.control;
  const versionAt = (place: Place, commit: string, path: string): string => {
    const v = (JSON.parse(f.read(place, commit, path)) as { version?: string }).version;
    if (!v) throw new Error(`${path} at ${commit.slice(0, 12)} names no version`);
    return v;
  };
  const vars: Record<string, string> = {
    contracts: versionAt('whombat', f.commit, 'packages/core/package.json'),
    app: versionAt('whombat', f.commit, 'apps/web/package.json'),
    whombat: f.sources.whombat,
    cloud: f.sources.cloud,
  };
  const fill = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value).replace(/\{(contracts|app|whombat|cloud)\}/g, (_, k: string) =>
        JSON.stringify(vars[k]).slice(1, -1),
      ),
    ) as T;
  const components: Component[] = list.components.map((c) => {
    const commit = commitOf(c);
    const source = f.sources[c.in];
    const version = c.version ?? versionAt(c.in, commit, join(c.dir ?? '', c.versionFrom ?? 'package.json'));
    return {
      id: c.id,
      repository: c.repository as Component['repository'],
      source,
      ...(c.dir ? { dir: c.dir } : {}),
      live: c.dir ? join(source, c.dir) : source,
      ref: 'main',
      commit,
      version,
      ...fill({ build: c.build, artifacts: c.artifacts, gates: c.gates, notes: c.notes }),
    };
  });
  return Pins.parse({
    $schema: 'whombat.integration-pins/1',
    productVersion: f.name,
    updatedAt: f.time,
    contracts: { version: vars.contracts, component: 'whombat-contracts' },
    components,
    tuple: { releaseId: `rt-${f.name.toLowerCase()}`, ...list.tuple },
    upgradePaths: [],
    placeholders: list.placeholders,
    evidence: [],
  });
}

/* Control and the relay: which whombat-cloud commits a release runs against ------------------------------------- */

/** What a release record says of whombat-cloud (`records/releases/<version>.json` in the maintainers' ops). */
export interface CloudRecord {
  version: string;
  cloud: { rev: string; parts: readonly string[] } | null;
}

const semver = (v: string): [number, number, number] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmp = (a: readonly number[], b: readonly number[]) =>
  (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);

/**
 * whombat-cloud's commit for control and for the relay as production ran them with a release. `given` (`--cloud`)
 * names both. Otherwise each part is the commit of the newest release record, up to this candidate, that deployed it;
 * a part no record deployed is what the old flow's last candidate pinned (`legacy`). A part nobody names stops the
 * run: a validation against a guessed control proves nothing.
 */
export function cloudCommits(o: {
  given: string | null;
  records: readonly CloudRecord[];
  /** This candidate's number: later records don't count. Null: every record does. */
  upTo: string | null;
  legacy: Partial<CloudCommits> | null;
}): CloudCommits {
  if (o.given) return { control: o.given, relay: o.given };
  const limit = o.upTo ? semver(o.upTo) : null;
  const records = o.records
    .map((r) => ({ r, v: semver(r.version) }))
    .filter((x): x is { r: CloudRecord; v: [number, number, number] } => x.v !== null)
    .filter((x) => !limit || cmp(x.v, limit) <= 0)
    .sort((a, b) => cmp(b.v, a.v));
  const of = (part: keyof CloudCommits): string => {
    const hit = records.find((x) => x.r.cloud?.parts.includes(part));
    const rev = hit?.r.cloud?.rev ?? o.legacy?.[part];
    if (!rev)
      throw new Error(
        `nothing says which whombat-cloud commit ${part === 'control' ? 'control' : 'the relay'} runs (no release record deployed it, and no candidate of the old flow pins it): name one with --cloud <commit>`,
      );
    return rev;
  };
  return { control: of('control'), relay: of('relay') };
}

/** The release records in whombat-ops (`records/releases/<x.y.z>.json`). */
export function readCloudRecords(ops: string | null): CloudRecord[] {
  const dir = ops ? join(ops, 'records', 'releases') : null;
  if (!dir || !existsSync(dir)) return [];
  const out: CloudRecord[] = [];
  for (const f of readdirSync(dir)) {
    const version = /^(\d+\.\d+\.\d+)\.json$/.exec(f)?.[1];
    if (!version) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { cloud?: CloudRecord['cloud'] };
      out.push({ version, cloud: r.cloud ?? null });
    } catch {
      // not a record: ignored
    }
  }
  return out;
}

/**
 * What the old flow's last candidate pinned for control and the relay: the newest `<x.y.z>.json` among the candidate
 * manifests, which are in the appliance's `manifest/candidates/` until releases move here and in whombat-ops'
 * `records/candidates/` afterwards.
 */
export function legacyCloud(dirs: readonly string[]): Partial<CloudCommits> | null {
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const newest = readdirSync(dir)
      .map((f) => ({ f, v: semver(f.replace(/\.json$/, '')) }))
      .filter((x): x is { f: string; v: [number, number, number] } => x.v !== null)
      .sort((a, b) => cmp(b.v, a.v))[0];
    if (!newest) continue;
    const pins = JSON.parse(readFileSync(join(dir, newest.f), 'utf8')) as {
      components?: { id: string; commit?: string }[];
    };
    const of = (id: string) => pins.components?.find((c) => c.id === id)?.commit;
    const control = of(CLOUD_IDS.control);
    const relay = of(CLOUD_IDS.relay);
    return { ...(control ? { control } : {}), ...(relay ? { relay } : {}) };
  }
  return null;
}

/* The pins of a commit, written where the harness reads them ----------------------------------------------------- */

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export interface PinsAt {
  /** A commit of the one repository (the appliance in `appliance/`). */
  rev: string;
  /** The candidate's number, when the commit is a release; default the commit's short id. */
  name?: string | null;
  /** `--cloud`: one whombat-cloud commit for control and the relay, instead of what the records say. */
  cloud?: string | null;
  /** The candidate's number records are read up to (default `name` when it is one). */
  upTo?: string | null;
  /** The file to write. */
  out: string;
  find?: FindOptions;
  env?: NodeJS.ProcessEnv;
}

/**
 * Writes the pins of a commit of the one repository and returns them. The list is the commit's own
 * (`appliance/manifest/components.json`): what a release is checked by is part of the release. A commit from before
 * the list existed takes this checkout's.
 */
export function writePinsAt(o: PinsAt): { file: string; pins: Pins; cloud: CloudCommits; listFrom: string } {
  const env = o.env ?? process.env;
  const source = findSource(o.rev, o.find ?? {});
  if (!source.dir)
    throw new Error(
      `${o.rev.slice(0, 12)} is a commit of the appliance's old repository: its pins are the candidate manifest that commit holds, not the component list`,
    );
  const rev = git(source.repository, 'rev-parse', `${o.rev}^{commit}`).trim();
  let listText: string;
  let listFrom = `${rev.slice(0, 12)}:${source.dir}/${COMPONENTS_FILE}`;
  try {
    listText = showAt({ ...source, rev }, COMPONENTS_FILE);
  } catch {
    listText = readFileSync(join(REPO_DIR, COMPONENTS_FILE), 'utf8');
    listFrom = join(REPO_DIR, COMPONENTS_FILE);
  }
  const list = ComponentList.parse(JSON.parse(listText));
  const cloudDir = expandHome(env.WHOMBAT_CLOUD || '~/Code/whombat-cloud');
  const ops = opsDir(REPO_DIR, env);
  const name = o.name || rev.slice(0, 12);
  const cloud = cloudCommits({
    given: o.cloud ? git(cloudDir, 'rev-parse', `${o.cloud}^{commit}`).trim() : null,
    records: readCloudRecords(ops),
    upTo: o.upTo ?? (semver(name) ? name : null),
    legacy: legacyCloud([
      ...(ops ? [join(ops, 'records', 'candidates')] : []),
      join(REPO_DIR, 'manifest', 'candidates'),
    ]),
  });
  const sources: Record<Place, string> = { whombat: source.repository, cloud: cloudDir };
  for (const [part, commit] of Object.entries(cloud))
    try {
      git(cloudDir, 'cat-file', '-e', `${commit}^{commit}`);
    } catch {
      throw new Error(
        `whombat-cloud ${commit.slice(0, 12)} (${part}) is not in ${cloudDir} (WHOMBAT_CLOUD): fetch it there, or name another commit with --cloud`,
      );
    }
  const pins = pinsFor(list, {
    commit: rev,
    time: Number(git(source.repository, 'show', '-s', '--format=%ct', rev).trim()),
    name,
    sources,
    cloud,
    read: (place, commit, path) => git(sources[place], 'show', `${commit}:${path}`),
  });
  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, `${JSON.stringify(pins, null, 2)}\n`);
  return { file: o.out, pins, cloud, listFrom };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name: string): string | null => {
    const i = args.indexOf(name);
    if (i < 0) return null;
    const v = args[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
    args.splice(i, 2);
    return v;
  };
  try {
    if (args.includes('-h') || args.includes('--help')) {
      process.stdout.write(
        'usage: manifest/pins-at [<commit>] [--name N] [--cloud <whombat-cloud commit>] [--out FILE]\n',
      );
      process.exit(0);
    }
    const name = value('--name');
    const cloud = value('--cloud');
    const out = value('--out');
    if (args.length > 1 || args[0]?.startsWith('-')) throw new Error(`unknown argument ${args.join(' ')}`);
    const rev = git(REPO_DIR, 'rev-parse', `${args[0] ?? 'HEAD'}^{commit}`).trim();
    const r = writePinsAt({
      rev,
      name,
      cloud,
      out: out ? resolve(out) : join(STATE_HOME, 'pins', `${name ?? rev.slice(0, 12)}.json`),
    });
    process.stderr.write(
      `pins-at: ${r.pins.components.length} components at ${rev.slice(0, 12)} (${r.listFrom}); control ${r.cloud.control.slice(0, 12)}, the relay ${r.cloud.relay.slice(0, 12)}\n`,
    );
    process.stdout.write(`${r.file}\n`);
  } catch (err) {
    process.stderr.write(`pins-at: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
