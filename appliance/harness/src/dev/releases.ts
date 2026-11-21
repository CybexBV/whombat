/**
 * Releases in the development TUF repository that describe the **real** local runtime (IN-21). Every runtime
 * artifact is a small JSON document the helper's fake activator imports (`FakeArtifact` of release-tools/devtuf):
 * the runtime version the real runtime reports (`build.version`), the schema range it really has (from its
 * `compat.json`), and `runtimeHealth` — `bad` makes the runtime bridge start the real runtime broken. Each artifact is
 * published as a one-path closure index (`tufrepo add-index`, IN-414), the tuple with `add-release` (development keys),
 * both in the channel the box follows (`DEV_CHANNEL`): a release is offered to the box by being the newest its channel
 * lists. Host and manager are placeholders shared by all releases (runtime-class updates only).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReleaseTuple } from '@whombat/release';
import { must } from '../lib/proc.ts';
import { fakeStorePath, schemaRange } from '../manifest/product.ts';

export const HOST_VERSION = '0.0.0-dev';

/**
 * The development manager's version, below every release build's manager version (NX-105, IN-99). The releases
 * published here name it, and the manager reports it with its commit as build metadata ({@link devManagerVersion}),
 * which version comparison ignores: control compares a candidate with what a box last reported and holds one whose
 * manager looks older (`not_older`), so a placeholder below it made every update scenario depend on whether the
 * manager's first status report reached control before its first poll. TUF refuses build metadata in a tuple.
 */
export const DEV_MANAGER_VERSION = '0.2.0-0.dev';

/** What the development manager reports to control (its config's `managerVersion`). */
export const devManagerVersion = (commit: string) => `${DEV_MANAGER_VERSION}+${commit.slice(0, 12)}`;
export const HOST_ABI = 1;
const HOST_PATH = fakeStorePath(`nixos-system-whombat-${HOST_VERSION}`);
const MANAGER_PATH = fakeStorePath(`whombat-manager-${HOST_VERSION}`);

const nar = (content: string | Buffer) =>
  `sha256:${createHash('sha256').update('nar:').update(content).digest('hex')}`;

export interface RuntimeFacts {
  /** What the real runtime reports as `version` (its package.json). */
  version: string;
  schema: { reads: number; writes: number };
}

export function runtimeFacts(runtimeSrc: string): RuntimeFacts {
  const pkg = JSON.parse(readFileSync(join(runtimeSrc, 'package.json'), 'utf8')) as { version: string };
  const schema = schemaRange(
    readFileSync(join(runtimeSrc, 'apps/server/src/db/migrations/compat.json'), 'utf8'),
  );
  return { version: pkg.version, schema };
}

export interface ReleaseOptions {
  id: string;
  runtime: RuntimeFacts;
  /** `bad`: the runtime bridge starts the real runtime so that its health check fails. */
  runtimeHealth?: 'ok' | 'bad';
  /** Declared schema range (defaults to the runtime's real one). */
  schemaReads?: { min: number; max: number };
  schemaWrites?: number;
  /** A fixture build the bridge runs for this release (IN-25). */
  source?: string;
  /** The fake activator asks for a checkpoint before migrating to `schemaWrites`. */
  contractMigration?: boolean;
  /** Client security floor (CT-53), set with `tufrepo add-release --client-floor`; unlisted platforms 0. */
  clientFloor?: Partial<Record<'web' | 'android' | 'ios' | 'desktop' | 'cli', number>>;
}

export function runtimeStorePath(id: string): string {
  return fakeStorePath(`whombat-runtime-${id}`);
}

/**
 * The update channel the environment's box follows (Whombat whombat-link.md LNK-20, LNK-23): every box takes the newest
 * release of its channel, and nothing is assigned to it. The development role is what people call Beta.
 */
export const DEV_CHANNEL = 'development';

/** Whether the repository has channel roles (`tufrepo add-channels`); one made before them has none. */
export function hasChannels(tuf: string): boolean {
  return existsSync(join(tuf, 'metadata', `1.${DEV_CHANNEL}.json`));
}

/**
 * The next release id of the environment's repository: `whombat-dev-YYYYMMDD.N`, the only kind a channel lists besides
 * `whombat-YYYYMMDD.N` (LNK-22), after every id published here before (a later day, or the day's next number). A box
 * takes the release whose id sorts last among those of equal versions, so each id made here is its channel's newest.
 */
export function nextReleaseId(tuf: string, now: Date = new Date()): string {
  const art = join(tuf, '..', 'artifacts');
  let day = now.toISOString().slice(0, 10).replace(/-/g, '');
  let n = 0;
  for (const f of existsSync(art) ? readdirSync(art) : []) {
    const m = /^whombat-dev-(\d{8})\.(\d+)\.tuple\.json$/.exec(f);
    if (!m?.[1] || !m[2]) continue;
    if (m[1] > day) {
      day = m[1];
      n = Number(m[2]);
    } else if (m[1] === day) n = Math.max(n, Number(m[2]));
  }
  return `whombat-dev-${day}.${n + 1}`;
}

/**
 * The release the environment's box started on. With channels it is the repository's first id (kept beside it); in
 * an environment from before them, the pins' own (`rt-<candidate>`).
 */
export function firstReleaseId(tuf: string, pinsId: string): string {
  const f = join(tuf, '..', 'first-release');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : pinsId;
}

/** `tufrepo <args>`; `add-*` commands change the box's channel role when the repository has channels. */
async function tufrepo(bin: string, dir: string, args: string[], log: string): Promise<void> {
  const inChannel = args[0]?.startsWith('add-') && hasChannels(dir) ? ['--channel', DEV_CHANNEL] : [];
  await must(join(bin, 'tufrepo'), [...args, ...inChannel], { cwd: dir, logFile: log });
}

/** Adds the shared host artifact once, then the release's runtime artifact and its tuple; returns the tuple. */
export async function publishRelease(
  bin: string,
  tuf: string,
  o: ReleaseOptions,
  log: string,
): Promise<ReleaseTuple> {
  const work = join(tuf, '..', 'artifacts');
  mkdirSync(work, { recursive: true });
  const hostFile = join(work, 'host.json');
  const hostContent = JSON.stringify({
    fake: true,
    kind: 'host-generation',
    name: 'whombat-host',
    version: HOST_VERSION,
    storePath: HOST_PATH,
    hostBoots: true,
  });
  if (!existsSync(hostFile)) {
    writeFileSync(hostFile, hostContent);
    await tufrepo(
      bin,
      tuf,
      [
        'add-index',
        '--dir',
        tuf,
        '--kind',
        'host',
        '--target',
        `host/${HOST_VERSION}/whombat-host.closure`,
        '--file',
        hostFile,
        '--version',
        HOST_VERSION,
        '--store-path',
        HOST_PATH,
        '--nar-hash',
        nar(hostContent),
        '--manager-store-path',
        MANAGER_PATH,
      ],
      log,
    );
  }
  const reads = o.schemaReads ?? { min: o.runtime.schema.reads, max: o.runtime.schema.writes };
  const writes = o.schemaWrites ?? o.runtime.schema.writes;
  const storePath = runtimeStorePath(o.id);
  const content = JSON.stringify({
    fake: true,
    kind: 'runtime-bundle',
    name: 'whombat-runtime',
    version: o.runtime.version,
    storePath,
    runtimeHealth: o.runtimeHealth ?? 'ok',
    schemaWrites: writes,
    schemaReadMin: reads.min,
    schemaReadMax: reads.max,
    releaseId: o.id,
    ...(o.source ? { source: o.source } : {}),
    ...(o.contractMigration ? { contractMigration: true } : {}),
  });
  const file = join(work, `${o.id}.runtime.json`);
  writeFileSync(file, content);
  await tufrepo(
    bin,
    tuf,
    [
      'add-index',
      '--dir',
      tuf,
      '--kind',
      'runtime',
      '--target',
      `runtime/${o.id}/whombat-runtime.closure`,
      '--file',
      file,
      '--version',
      o.runtime.version,
      '--store-path',
      storePath,
      '--nar-hash',
      nar(content),
    ],
    log,
  );
  const tuple: ReleaseTuple = {
    releaseId: o.id,
    runtime: {
      version: o.runtime.version,
      storePath,
      narHash: nar(content),
      schemaReads: reads,
      schemaWrites: writes,
      protocol: { min: 1000, max: 1000 },
      hostAbi: { min: HOST_ABI, max: HOST_ABI },
    },
    providers: [],
    host: { version: HOST_VERSION, storePath: HOST_PATH, narHash: nar(hostContent), abi: HOST_ABI },
    manager: { version: DEV_MANAGER_VERSION, storePath: MANAGER_PATH, narHash: nar(MANAGER_PATH) },
  };
  const tupleFile = join(work, `${o.id}.tuple.json`);
  writeFileSync(tupleFile, JSON.stringify(tuple));
  const floor = o.clientFloor
    ? Object.entries(o.clientFloor)
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
    : '';
  await tufrepo(
    bin,
    tuf,
    ['add-release', '--dir', tuf, '--tuple', tupleFile, ...(floor ? ['--client-floor', floor] : [])],
    log,
  );
  if (o.clientFloor) {
    // The tuple control registers must be the one TUF signed (same digest).
    tuple.clientFloor = { web: 0, android: 0, ios: 0, desktop: 0, cli: 0, ...o.clientFloor };
    writeFileSync(tupleFile, JSON.stringify(tuple));
  }
  return tuple;
}

export function readTuple(tuf: string, id: string): ReleaseTuple {
  return JSON.parse(readFileSync(join(tuf, '..', 'artifacts', `${id}.tuple.json`), 'utf8')) as ReleaseTuple;
}

export { HOST_PATH, MANAGER_PATH };
