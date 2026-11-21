/**
 * `dev/publish-release` — a real release (release/build, `tufrepo export-release`) on the dev instance
 * (NX-68): the dev instance's analogue of control `infra/hetzner/deploy.sh release`.
 *
 *   dev/publish-release <release-dir> [--record <record.json>] [--rollout <device>] [--waves default|all-at-once|rehearsal|<file>]
 *                       [--allow-downgrade-from <id>,…] [--json]
 *
 * 1. checks the directory against its SHA256SUMS (the top-level files; a release.json v2's `nar/` blobs are checked by
 *    tufrepo one by one) and `release.json`; a v2 directory (closure indexes, UP-X14) needs a tufrepo whose
 *    `features` lists `closure-index`;
 * 2. `tufrepo publish-release` into the instance's repository (`$WB_MGD_HOME/env/manager/tuf`, environment `local`,
 *    its development keys; the tool re-verifies every stream and blob, NAR hash and closure size, reuses the blobs the
 *    repository has, and signs targets, snapshot and timestamp);
 * 3. registers the tuple with control (`POST /v1/operator/releases`; control never reads TUF) and checks control's
 *    tuple digest is TUF's; with `--record`, the release record (notes, gates, …; UP-X02) goes with it, or with
 *    `PUT /v1/operator/releases/<id>/record` when the release was registered before. A control without records
 *    (before contracts 0.22) is told nothing and the tool says so;
 * 4. `--rollout <device>` marks that device internal first. Refused while another live device is internal (it would be
 *    assigned the release too) or another rollout is open (one at a time); both are the operator's to resolve, never
 *    this tool's;
 * 5. a rollout: `--waves default` (UP-E1: internal, pilot, canary, general 10 %, general), `--waves all-at-once` (one
 *    wave, every cohort) or `--waves <file>` (a JSON array of waves, or `{"waves": […]}`); `--rollout` alone is one
 *    wave to the internal cohort. `--waves rehearsal` (with `--rollout`) is the bridge rehearsal's: the internal cohort
 *    only, held a week (dev/move.ts `REHEARSAL_HOLD_S`), so it never completes, and offers its release to every box,
 *    before it is stopped. Every preset pauses at the first failure (threshold 0, sample 1; IN-98).
 *
 * `--allow-downgrade-from <id>,…` publishes a release older than those (a custody rollback, MA-21c): tufrepo signs the
 * `allowDowngradeFrom` the helper checks, and the record carries the list so control offers it only to boxes on them
 * (contracts 0.22.1).
 *
 * `--json` prints the outcome as one JSON line on stdout (`release/ship publish-dev` reads it).
 * `tufrepo` is `$WB_TUFREPO`, else this checkout's `whombat-release-tools` (nix build; `tufrepo.ts`, which the dev stack's
 * timestamp refresher uses too, IN-224).
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROLLOUT_PRESETS as CONTRACT_PRESETS, type RolloutPreset } from '@whombat/control-contracts';
import { TMP_DIR } from '../lib/paths.ts';
import { must, run } from '../lib/proc.ts';
import { ControlError, controlApi } from '../scenario-kit/cloud.ts';
import { envPath, loadEnv } from './env.ts';
import { REHEARSAL_HOLD_S } from './move.ts';
import { tufrepoBin } from './tufrepo.ts';

export interface PublishArgs {
  dir: string;
  rollout: string | null;
  waves: string | null;
  record: string | null;
  allowDowngradeFrom: string[];
  json: boolean;
}

export function parseArgs(argv: readonly string[]): PublishArgs {
  let dir: string | null = null;
  let rollout: string | null = null;
  let waves: string | null = null;
  let record: string | null = null;
  let allowDowngradeFrom: string[] = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--rollout') {
      rollout = argv[++i] ?? '';
      if (!/^wb-[a-z0-9-]+$/.test(rollout)) throw new Error(`--rollout needs a device id, not “${rollout}”`);
    } else if (a === '--waves') {
      waves = argv[++i] ?? '';
      if (!waves) throw new Error('--waves needs default, all-at-once or a file');
    } else if (a === '--record') {
      record = argv[++i] ?? '';
      if (!record) throw new Error('--record needs a file');
    } else if (a === '--allow-downgrade-from') {
      allowDowngradeFrom = (argv[++i] ?? '').split(',').filter(Boolean);
      if (
        !allowDowngradeFrom.length ||
        allowDowngradeFrom.some((x) => !/^[a-z0-9][a-z0-9._-]{2,79}$/.test(x))
      )
        throw new Error('--allow-downgrade-from takes release ids, comma-separated');
    } else if (a === '--json') json = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (dir === null) dir = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!dir)
    throw new Error(
      'usage: dev/publish-release <release-dir> [--record <record.json>] [--rollout <device>] [--waves default|all-at-once|<file>] [--json]',
    );
  return {
    dir: resolve(dir),
    rollout,
    waves,
    record: record ? resolve(record) : null,
    allowDowngradeFrom,
    json,
  };
}

export interface WaveInput {
  index: number;
  cohorts: string[];
  basisPoints: number;
  minObservationS: number;
  failureThresholdBp: number;
  minSample: number;
}

/**
 * UP-E1's presets are the contracts' (`ROLLOUT_PRESETS`, CT-140): the staged default and one wave for everything. Any
 * failure pauses (threshold 0, minimum sample 1); control promotes a wave once its window passed with every activated
 * device healthy, an empty wave at once.
 */
export const ROLLOUT_PRESETS: Record<RolloutPreset, WaveInput[]> = {
  default: CONTRACT_PRESETS.default.map((w) => ({ ...w })),
  'all-at-once': CONTRACT_PRESETS['all-at-once'].map((w) => ({ ...w })),
};

/** `--rollout <device>` without `--waves`: the internal cohort, one wave (the device is the only internal one). */
export const INTERNAL_ONLY: WaveInput[] = [
  {
    index: 0,
    cohorts: ['internal'],
    basisPoints: 10_000,
    minObservationS: 0,
    failureThresholdBp: 0,
    minSample: 1,
  },
];

/**
 * `--waves rehearsal`: one device, the internal one, held: a completed rollout's release is offered to every box
 * (control `computeDesired`), so the bridge rehearsal's must not complete before it is stopped (dev/move.ts).
 */
export const REHEARSAL: WaveInput[] = [
  { ...(INTERNAL_ONLY[0] as WaveInput), minObservationS: REHEARSAL_HOLD_S },
];

const COHORTS = ['internal', 'pilot', 'canary', 'general'];

/** The waves a `--waves` value names; a file is checked for shape (control checks the rest). */
export function wavesFor(
  spec: string | null,
  rollout: string | null,
  read = (f: string) => readFileSync(f, 'utf8'),
) {
  if (spec === null) return rollout ? INTERNAL_ONLY : null;
  if (spec === 'default' || spec === 'all-at-once') return ROLLOUT_PRESETS[spec];
  if (spec === 'rehearsal') {
    if (!rollout) throw new Error('--waves rehearsal needs --rollout <device> (the DEV box VM)');
    return REHEARSAL;
  }
  const parsed = JSON.parse(read(spec)) as unknown;
  const list = (Array.isArray(parsed) ? parsed : (parsed as { waves?: unknown }).waves) as
    | WaveInput[]
    | undefined;
  if (!Array.isArray(list) || !list.length) throw new Error(`${spec}: no waves`);
  return list.map((w, index) => {
    if (!Array.isArray(w.cohorts) || !w.cohorts.length || w.cohorts.some((c) => !COHORTS.includes(c)))
      throw new Error(`${spec}: wave ${index} needs cohorts among ${COHORTS.join(', ')}`);
    for (const k of ['basisPoints', 'minObservationS', 'failureThresholdBp', 'minSample'] as const)
      if (!Number.isInteger(w[k])) throw new Error(`${spec}: wave ${index} needs an integer ${k}`);
    return { ...w, index };
  });
}

interface OperatorDevice {
  device: string;
  internal?: boolean;
  state: string;
}

/** Devices other than `device` that are internal and not retired: a rollout to the internal cohort reaches them. */
export function otherInternal(devices: readonly OperatorDevice[], device: string): string[] {
  return devices
    .filter((d) => d.internal && d.device !== device && d.state !== 'retired')
    .map((d) => d.device);
}

/** `SHA256SUMS` lines (`<hex>  <file>`), every file checked. */
export async function checkSums(dir: string): Promise<string[]> {
  const lines = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean);
  const files: string[] = [];
  for (const line of lines) {
    const m = /^([0-9a-f]{64}) [ *]([A-Za-z0-9._+-]+)$/.exec(line);
    if (!m?.[1] || !m[2]) throw new Error(`SHA256SUMS: bad line “${line}”`);
    const h = createHash('sha256');
    for await (const chunk of createReadStream(join(dir, m[2]))) h.update(chunk as Buffer);
    if (h.digest('hex') !== m[1]) throw new Error(`${m[2]} doesn’t match SHA256SUMS`);
    files.push(m[2]);
  }
  if (!files.includes('release.json')) throw new Error('SHA256SUMS doesn’t cover release.json');
  return files;
}

/** A release directory with closure indexes (release.json v2, UP-X14): it needs a tufrepo that publishes them. */
export function hasIndexes(release: { v?: number; indexes?: unknown[] }): boolean {
  return (release.v ?? 1) >= 2 && Array.isArray(release.indexes) && release.indexes.length > 0;
}

export interface PublishResult {
  releaseId: string;
  tupleDigest: string;
  added: string[];
  reused: string[];
  alreadyPublished: boolean;
  /** Since UP-X14: the blobs copied into the repository, those it had, and the bytes added. */
  blobsAdded?: number;
  blobsReused?: number;
  bytesAdded?: number;
}

const mb = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;

/** One line about what `tufrepo publish-release` did. */
export function publishedLine(id: string, pub: PublishResult): string {
  if (pub.alreadyPublished) return `${id}: already published, tupleDigest ${pub.tupleDigest}`;
  const blobs =
    typeof pub.blobsAdded === 'number'
      ? `; blobs ${pub.blobsAdded} added (${mb(pub.bytesAdded ?? 0)}), ${pub.blobsReused ?? 0} reused`
      : '';
  return `${id}: published (${pub.added.length} added, ${pub.reused.length} reused${blobs}), tupleDigest ${pub.tupleDigest}`;
}

/** `tufrepo features` (one name per line); empty for a tufrepo without the command. */
async function tufrepoFeatures(bin: string): Promise<string[]> {
  const r = await run(bin, ['features'], { cwd: TMP_DIR, timeoutMs: 30_000 });
  return r.code === 0
    ? r.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    : [];
}

/** A 400 that names `record` (a control before contracts 0.22 validates the body strictly). */
export function refusedForRecord(err: unknown): boolean {
  return (
    err instanceof ControlError &&
    err.status === 400 &&
    /record|unrecognized|unknown/i.test(JSON.stringify(err.body))
  );
}

export interface PublishOutcome {
  releaseId: string;
  tupleDigest: string;
  alreadyPublished: boolean;
  registered: string;
  record: 'stored' | 'unsupported' | null;
  rollout: { rollout: string; state: string; waves: number } | null;
  /** Blobs copied into the repository and their bytes (UP-X14), when tufrepo says. */
  blobsAdded?: number;
  bytesAdded?: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const e = loadEnv();
  if (!e?.control) throw new Error('no dev instance here (WB_MGD_HOME, dev/up)');
  const control = e.control;
  const say = (s: string) => (args.json ? process.stderr : process.stdout).write(`publish-release: ${s}\n`);
  const log = join(TMP_DIR, 'publish-release.log');

  const release = JSON.parse(readFileSync(join(args.dir, 'release.json'), 'utf8')) as {
    v?: number;
    releaseId: string;
    tuple: { releaseId: string };
    indexes?: unknown[];
  };
  if (release.tuple.releaseId !== release.releaseId)
    throw new Error('release.json: the tuple is another release');
  const id = release.releaseId;
  const waves = wavesFor(args.waves, args.rollout);
  const given = args.record
    ? (JSON.parse(readFileSync(args.record, 'utf8')) as Record<string, unknown>)
    : null;
  const record = args.allowDowngradeFrom.length
    ? { ...(given ?? {}), allowDowngradeFrom: args.allowDowngradeFrom }
    : given;
  say(`${id}: checking ${(await checkSums(args.dir)).length} files against SHA256SUMS`);

  const op = <T>(method: string, path: string, body?: unknown) =>
    controlApi<T>(control.adminUrl, method, `/v1/operator${path}`, {
      token: readFileSync(control.operatorTokenFile, 'utf8').trim(),
      ...(body !== undefined ? { body } : {}),
    });
  if (waves) {
    // Refuse before anything is published or registered.
    const { devices } = await op<{ devices: OperatorDevice[] }>('GET', '/devices');
    if (args.rollout) {
      if (!devices.some((d) => d.device === args.rollout))
        throw new Error(`control has no device ${args.rollout}`);
      const others = otherInternal(devices, args.rollout);
      if (others.length)
        throw new Error(`other devices are internal and would get ${id} too: ${others.join(', ')}`);
    }
    const open = (
      await op<{ rollouts: { rollout: string; state: string; release: string }[] }>('GET', '/rollouts')
    ).rollouts.filter((r) => r.state === 'active' || r.state === 'paused');
    if (open.length)
      throw new Error(
        `a rollout is open (${open.map((r) => `${r.rollout}: ${r.release}`).join(', ')}); stop it first`,
      );
  }

  const tuf = envPath('manager', 'tuf');
  if (!existsSync(join(tuf, 'metadata', 'root.json'))) throw new Error(`${tuf} is not a TUF repository`);
  const bin = await tufrepoBin(log);
  if (hasIndexes(release) && !(await tufrepoFeatures(bin)).includes('closure-index'))
    throw new Error(
      `${id} has closure indexes (release.json v2) and ${bin} can't publish them (no closure-index feature): use this checkout's tufrepo (WB_TUFREPO unset)`,
    );
  say(
    `${id}: tufrepo publish-release into ${tuf} (verifies every stream and blob${hasIndexes(release) ? `, ${release.indexes?.length} closure indexes` : ''})`,
  );
  const pub = JSON.parse(
    (
      await must(
        bin,
        [
          'publish-release',
          '--dir',
          tuf,
          '--release-dir',
          args.dir,
          ...(args.allowDowngradeFrom.length
            ? ['--allow-downgrade-from', args.allowDowngradeFrom.join(',')]
            : []),
        ],
        {
          cwd: tuf,
          logFile: log,
        },
      )
    ).stdout,
  ) as PublishResult;
  say(publishedLine(id, pub));

  let registered: { release: string; tupleDigest: string; state?: string };
  let recordState: PublishOutcome['record'] = null;
  let fresh = true;
  const register = (withRecord: boolean) =>
    op<{ release: string; tupleDigest: string; state?: string }>('POST', '/releases', {
      tuple: release.tuple,
      ...(withRecord && record ? { record } : {}),
    });
  try {
    try {
      registered = await register(true);
      if (record) recordState = 'stored';
    } catch (err) {
      if (!record || !refusedForRecord(err)) throw err;
      say(`${id}: control refused the record (${(err as Error).message}); registering the tuple alone`);
      registered = await register(false);
      recordState = 'unsupported';
    }
  } catch (err) {
    // Registered before (a re-run): control's copy must be the same tuple.
    const { releases } = await op<{ releases: { release: string; tupleDigest?: string; state: string }[] }>(
      'GET',
      '/releases',
    );
    const known = releases.find((r) => r.release === id);
    if (!known) throw err;
    registered = { release: id, tupleDigest: known.tupleDigest ?? '', state: known.state };
    fresh = false;
  }
  if (registered.tupleDigest !== pub.tupleDigest)
    throw new Error(`control's tuple digest ${registered.tupleDigest} differs from TUF's ${pub.tupleDigest}`);
  say(`${id}: registered with control (${registered.state ?? 'approved'})`);
  if (record && !fresh) {
    try {
      await op('PUT', `/releases/${id}/record`, record);
      recordState = 'stored';
    } catch (err) {
      if (!(err instanceof ControlError) || ![404, 405, 400].includes(err.status)) throw err;
      recordState = 'unsupported';
    }
  }
  if (recordState === 'stored') say(`${id}: release record stored with control`);
  if (recordState === 'unsupported')
    say(`${id}: this control keeps no release records yet (needs a control with contracts 0.22); not stored`);

  let rollout: PublishOutcome['rollout'] = null;
  if (waves) {
    if (args.rollout) await op('PUT', `/devices/${args.rollout}/internal`, { internal: true });
    const r = await op<{ rollout: string; state: string }>('POST', '/rollouts', { release: id, waves });
    rollout = { rollout: r.rollout, state: r.state, waves: waves.length };
    say(
      `${id}: rollout ${r.rollout} (${r.state}), ${waves.length} wave${waves.length === 1 ? '' : 's'} (${args.waves ?? 'internal'})${args.rollout ? `; ${args.rollout} is internal` : ''}`,
    );
    writeFileSync(join(TMP_DIR, `publish-release-${id}.rollout`), `${r.rollout}\n`);
  }
  if (args.json) {
    const out: PublishOutcome = {
      releaseId: id,
      tupleDigest: pub.tupleDigest,
      alreadyPublished: pub.alreadyPublished,
      registered: registered.state ?? 'approved',
      record: recordState,
      rollout,
      ...(typeof pub.blobsAdded === 'number'
        ? { blobsAdded: pub.blobsAdded, bytesAdded: pub.bytesAdded ?? 0 }
        : {}),
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`publish-release: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
