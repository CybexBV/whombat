/**
 * `release/ship promote-prod <prod id> [--waves …] [--yes]` (UP-E1, UP-C4; IN-99): the PROD release to
 * production through control's `deploy.sh`, in staged waves, followed to the end.
 *
 * Without `--yes` it prints the plan and stops. It refuses unless both branches of the chain — gates.json →
 * upgrade-gates.json and dev-soak.json, each after the same build.json (IN-115) — are ok and complete (nothing
 * skipped), when the build is DEV-only or skipped the newer check, or when the fleet check fails: boxes that would
 * wait for a checkpoint without a backup destination (UP-F1). With `--yes`: for a host release without an ISO it
 * builds the ISO first (UP-X15, before anything is published), then `deploy.sh release <id> <dir> --waves … --record
 * <record.json>` (and `deploy.sh iso` for a host release), then it follows the rollout until it completes
 * (exit 0) or pauses or stops (exit 1, with the pause's detail), writes `promote.json` and, when completed, promotes
 * `manifest/pins.json` to the candidate and moves `vm-tests/upgrade-gates/previous.json` on, in one commit (UP-C4).
 * `--follow-only` resumes following after an interrupt.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRetryableUpdateFailure } from '@whombat/release';
import { ROLLOUT_PRESETS, wavesFor } from '../dev/publish-release.ts';
import { run, sleep } from '../lib/proc.ts';
import { git, prodOp, type ShipContext, say } from './context.ts';
import { prodId } from './ids.ts';
import { ensureIso, type IsoInfo } from './iso.ts';
import type { ReleaseNotes } from './notes.ts';
import { builtFromOf, describePause, releaseRecord } from './record.ts';
import { AFTER, type ChainedRecord, incomplete, nextChain, verifyChain, writeRecord } from './records.ts';

export interface FleetDevice {
  device: string;
  state: string;
  internal?: boolean;
  lastSeenAt?: number | null;
  status?: {
    release?: string;
    managerVersion?: string;
    update?: { state?: string; failure?: string | null; failureDetail?: Record<string, unknown> | null };
    health?: Record<string, string>;
  };
}

interface Rollout {
  rollout: string;
  release: string;
  state: string;
  currentWave?: number;
  waves?: { index: number; cohorts: string[]; basisPoints: number; state: string }[];
  pauseReason?: string | null;
  pauseDetail?: Record<string, unknown> | null;
  createdAt?: number;
}

export function planText(o: {
  id: string;
  cls: string;
  notes: ReleaseNotes;
  waves: { cohorts: string[]; basisPoints: number; minObservationS: number }[];
  devices: FleetDevice[];
  wavesName: string;
}): string {
  const h = (s: number) => (s >= 3600 ? `${s / 3600} h` : s ? `${s / 60} min` : 'none');
  const live = o.devices.filter((d) => d.state === 'claimed');
  const lines = [
    `Release ${o.id} (${o.cls}): ${o.notes.summary}`,
    '',
    `Database: schema ${o.notes.schema.from ?? '?'} → ${o.notes.schema.to}${o.notes.migrations.length ? ` (${o.notes.migrations.map((m) => `${m.tag} ${m.class}`).join(', ')})` : ', no migration'}.`,
    '',
    `Waves (${o.wavesName}; any failure pauses the rollout; control promotes a wave when its window passed with every activated device healthy, an empty wave at once):`,
    ...o.waves.map(
      (w, i) =>
        `  ${i + 1}. ${w.cohorts.join(', ')} ${w.basisPoints / 100} % — observe ${h(w.minObservationS)}`,
    ),
    '',
    `Devices (${live.length} claimed): internal ones are in wave 1, the others by their organization's cohort.`,
    ...live.map(
      (d) =>
        `  ${d.device}${d.internal ? ' (internal)' : ''}: ${d.status?.release ?? '?'} · manager ${d.status?.managerVersion ?? '?'} · ${d.status?.update?.state ?? '?'}`,
    ),
    '',
    'How to stop: infra/hetzner/deploy.sh rollout pause <rollout> <reason> (resume later) or rollout stop <rollout>',
    '<reason>; for every box at once: deploy.sh emergency-stop on. A box that already activated keeps the release;',
    "going back is a custody rollback (the maintainers' shipping runbook).",
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * The upgrade gates' previous releases after a promotion (NX-110): N−1 becomes the release just promoted, N−2 the
 * N−1 before it.
 */
export function nextPrevious(previous: string[], promoted: string): string[] {
  if (previous[0] === promoted) return previous.slice(0, 2);
  return [promoted, ...previous.slice(0, 1)];
}

/**
 * UP-C4: pins.json (and its built manifest) become the candidate's, and the upgrade gates' previous releases move
 * (`vm-tests/upgrade-gates/previous.json`), committed together on the current branch.
 */
export async function promotePins(
  ctx: ShipContext,
  candidate: string,
  releaseId: string,
): Promise<string | null> {
  const m = join(ctx.repo, 'manifest');
  const src = join(m, 'candidates', `${candidate}.json`);
  const pairs: [string, string][] = [
    [src, join(m, 'pins.json')],
    [join(m, 'candidates', `${candidate}.build-report.json`), join(m, 'build-report.json')],
    [join(m, 'candidates', `${candidate}.product-manifest.json`), join(m, 'product-manifest.json')],
    [join(m, 'candidates', `${candidate}.annotations.json`), join(m, 'product-manifest.annotations.json')],
  ];
  const dirty = await git(ctx.repo, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) {
    say(`pins not promoted: the tree has changes (${dirty.split('\n').length} files); do it by hand (UP-C4)`);
    return null;
  }
  const copied: string[] = [];
  const missing: string[] = [];
  for (const [from, to] of pairs)
    if (existsSync(from)) {
      copyFileSync(from, to);
      copied.push(to);
    } else missing.push(from);
  const prevFile = join(ctx.repo, 'vm-tests', 'upgrade-gates', 'previous.json');
  if (existsSync(prevFile)) {
    const prev = JSON.parse(readFileSync(prevFile, 'utf8')) as { previous: string[]; [k: string]: unknown };
    const moved = nextPrevious(prev.previous, releaseId);
    if (moved.join() !== prev.previous.join()) {
      writeFileSync(prevFile, `${JSON.stringify({ ...prev, previous: moved }, null, 2)}\n`);
      copied.push(prevFile);
      say(`upgrade gates' previous releases: ${moved.join(', ')} (was ${prev.previous.join(', ')})`);
    }
  }
  // harness/validate builds the candidate's manifest; without it pins.json moves alone and manifest/build must follow.
  if (missing.length) say(`not in the candidate: ${missing.join(', ')}; run manifest/build for pins.json`);
  if (!(await git(ctx.repo, ['status', '--porcelain', '--untracked-files=no']))) {
    say('pins.json already names this candidate');
    return null;
  }
  await git(ctx.repo, ['add', ...copied]);
  await git(ctx.repo, [
    'commit',
    '-q',
    '-m',
    `manifest: pins.json is candidate ${candidate}, published to production as ${releaseId}; the upgrade gates' N−1 is ${releaseId} (UP-C4)\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`,
  ]);
  const rev = await git(ctx.repo, ['rev-parse', 'HEAD']);
  const branch = await git(ctx.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  say(
    `pins.json promoted to ${candidate} (${rev.slice(0, 12)} on ${branch}${branch === 'main' ? '' : '; merge it into main'})`,
  );
  return rev;
}

interface RolloutDeviceView {
  device: string;
  wave?: number | null;
  state?: string | null;
  failure?: string | null;
  failureDetail?: Record<string, unknown> | null;
  hold?: string | null;
  waiting?: { reason: string; since: number };
  updatedAt?: number | null;
}

/**
 * The wave a rollout is in, 0-based: control's `Rollout` carries no current-wave field (the follow loop showed “wave 1
 * of 5” while wave 5 was active): the first wave that is active, observing or paused; all promoted: the last.
 */
export function currentWaveOf(r: { currentWave?: number; waves?: { state?: string }[] }): number {
  if (typeof r.currentWave === 'number') return r.currentWave;
  const waves = r.waves ?? [];
  const i = waves.findIndex((w) => w.state === 'active' || w.state === 'observing' || w.state === 'paused');
  if (i >= 0) return i;
  const promoted = waves.filter((w) => w.state === 'promoted').length;
  return Math.max(0, Math.min(promoted, waves.length - 1));
}

const utc = (s: number) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * One device as the follow loop prints it: its state, why it waits or is held, a failure it will retry. A device
 * without a state in the rollout (it hasn't reported on this release) shows its last report from the device list, and
 * `offline since …` when it hasn't reported for 15 minutes.
 */
export function deviceLine(
  d: RolloutDeviceView,
  seen?: { lastSeenAt?: number | null; state?: string | null } | null,
  now = Math.floor(Date.now() / 1000),
): string {
  let state = d.state ?? null;
  if (!state) {
    const last = seen?.state ? `last ${seen.state}` : 'no report on this release';
    const offline =
      seen?.lastSeenAt && now - seen.lastSeenAt > 900 ? `, offline since ${utc(seen.lastSeenAt)}` : '';
    state = `(${last}${offline})`;
  }
  const parts = [`${d.device} ${state}`];
  if (d.waiting) parts.push(`waiting: ${d.waiting.reason}`);
  if (d.hold) parts.push(`held: ${d.hold}`);
  if (d.failure)
    parts.push(isRetryableUpdateFailure(d.failure) ? `retrying after ${d.failure}` : `failed: ${d.failure}`);
  return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : (parts[0] ?? '');
}

/** How long a wave may show no progress before the follow loop gives up: twice its window, at least an hour. */
export function stallLimitS(
  r: Pick<Rollout, 'waves' | 'currentWave'>,
  minObservation: (w: number) => number,
): number {
  return Math.max(3600, 2 * minObservation(currentWaveOf(r)));
}

async function follow(
  ctx: ShipContext,
  id: string,
): Promise<{ ok: boolean; rollout: Rollout | null; detail: string; stalled?: RolloutDeviceView[] }> {
  let last = '';
  let changedAt = Date.now();
  for (;;) {
    const list = await prodOp<{ rollouts: Rollout[] }>(ctx, 'GET', '/v1/operator/rollouts');
    if (!list)
      throw new Error(
        'deploy.sh has no `op` command: can’t follow the rollout (whombat-cloud’s infra/hetzner/deploy.sh)',
      );
    const r = list.rollouts
      .filter((x) => x.release === id)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
    if (!r) throw new Error(`control has no rollout of ${id}`);
    const devs = await prodOp<{ devices: RolloutDeviceView[] }>(
      ctx,
      'GET',
      `/v1/operator/rollouts/${r.rollout}/devices`,
    ).catch(() => null);
    const fleet = await prodOp<{ devices: FleetDevice[] }>(ctx, 'GET', '/v1/operator/devices').catch(
      () => null,
    );
    const seenOf = (id: string) => {
      const f = fleet?.devices.find((x) => x.device === id);
      return f ? { lastSeenAt: f.lastSeenAt ?? null, state: f.status?.update?.state ?? null } : null;
    };
    // Waves numbered from 1, as deploy.sh numbers them (control).
    const line = `rollout ${r.rollout} ${r.state}, wave ${currentWaveOf(r) + 1} of ${r.waves?.length ?? '?'}${
      devs ? ` · ${devs.devices.map((d) => deviceLine(d, seenOf(d.device))).join(', ')}` : ''
    }`;
    if (line !== last) {
      say(line);
      last = line;
      changedAt = Date.now();
    }
    if (r.state === 'completed') return { ok: true, rollout: r, detail: 'completed' };
    if (r.state === 'paused' || r.state === 'stopped') {
      const detail = `${r.state}: ${describePause(r as Parameters<typeof describePause>[0])}`;
      return { ok: false, rollout: r, detail };
    }
    const limit = stallLimitS(
      r,
      (w) => (r.waves?.[w] as { minObservationS?: number } | undefined)?.minObservationS ?? 0,
    );
    if (Date.now() - changedAt > limit * 1000) {
      const waiting = (devs?.devices ?? []).filter((d) => d.state !== 'Healthy' || d.waiting || d.hold);
      return {
        ok: false,
        rollout: r,
        stalled: waiting,
        detail: `no progress for ${Math.round(limit / 3600)} h in wave ${currentWaveOf(r) + 1}: ${waiting.map((d) => deviceLine(d, seenOf(d.device))).join(', ') || 'no device reported'}`,
      };
    }
    await sleep(60_000);
  }
}

/** What to run again for each record that skipped something (promote-prod's refusal, F14). */
export function rerunAdvice(chain: { stage: string; record: ChainedRecord }[], id: string): string {
  const out: string[] = [];
  for (const c of chain) {
    if (c.record.chain.complete) continue;
    if (c.stage === 'build')
      out.push(
        `build it again, complete, under the next free id: release/ship build <whombat-YYYYMMDD.N> (no --dev-only, --no-newer-check or --override-input), then every stage after it`,
      );
    else if (c.stage === 'gates' || c.stage === 'upgrade-gates')
      out.push(`release/ship validate ${id} (no --skip-… or --scenarios)`);
    else if (c.stage === 'dev-soak') out.push(`release/ship publish-dev ${id}`);
  }
  return `Run: ${[...new Set(out)][0] ?? 'the stage named above again'}`;
}

/**
 * UP-F1: claimed boxes whose last report says `backup unconfigured` and that would run a `contract` or `incompatible`
 * migration of this release (the manager needs a verified checkpoint first; without a destination it waits).
 */
export function unprotectedBoxes(
  devices: FleetDevice[],
  migrations: { tag: string; version: number; class: string }[],
  schemaOf: (release: string) => number | null,
): { device: string; release: string; migrations: string[] }[] {
  const breaking = migrations.filter((m) => m.class === 'contract' || m.class === 'incompatible');
  if (!breaking.length) return [];
  return devices
    .filter((d) => d.state === 'claimed' && d.status?.health?.backup === 'unconfigured')
    .map((d) => {
      const cur = d.status?.release ? schemaOf(d.status.release) : null;
      return {
        device: d.device,
        release: d.status?.release ?? '?',
        migrations: breaking.filter((m) => cur === null || m.version > cur).map((m) => `${m.tag} ${m.class}`),
      };
    })
    .filter((u) => u.migrations.length > 0);
}

export async function promoteProd(
  ctx: ShipContext,
  a: {
    prodId: string;
    waves: string;
    yes: boolean;
    followOnly: boolean;
    allowUnprotected: boolean;
    /** `--without-validation <reason>`: John's word to ship without validate's records (IN-158). */
    withoutValidation?: string | null;
  },
): Promise<{ ok: boolean; promoted: boolean; detail: string }> {
  const prod = prodId(a.prodId);
  const dir = join(ctx.root, prod.id);
  // Both branches, for the same build.json (IN-115): validate's gates → upgrade-gates and publish-dev's dev-soak.
  // Without validation (IN-158) only publish-dev's: the DEV box ran the twin and its smoke passed.
  const after = a.withoutValidation ? (['dev-soak'] as const) : AFTER.promote;
  const chain = verifyChain(dir, prod.id, after);
  if (a.withoutValidation)
    say(
      `--without-validation: no gates or upgrade gates are required (${a.withoutValidation}); recorded in the release record and promote.json`,
    );
  const missing = incomplete(chain);
  if (missing.length)
    throw new Error(
      `production takes only a complete chain; these records skipped something:\n  ${missing.join('\n  ')}\n${rerunAdvice(chain, prod.id)}`,
    );
  const build = chain[0]?.record as ChainedRecord & {
    devOnly?: boolean;
    class: string;
    source: { rev: string };
    runtime: { whombatRev: string };
    tuple?: { runtime: { schemaWrites: number } };
    ship: { candidate: { name: string; file: string }; twin: { releaseId: string }; contracts?: string };
  };
  if (build.devOnly || !build.tuple)
    throw new Error(`${prod.id} was built DEV-only: build it again without --dev-only`);
  const notes = JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf8')) as ReleaseNotes;
  let unprotected: { device: string; release: string; migrations: string[] }[] = [];

  if (!a.followOnly) {
    // The fleet check.
    const devices = await prodOp<{ devices: FleetDevice[] }>(ctx, 'GET', '/v1/operator/devices');
    if (!devices)
      throw new Error(
        'deploy.sh has no `op` command: the fleet check can’t run (whombat-cloud’s infra/hetzner/deploy.sh)',
      );
    const releases =
      (
        await prodOp<{ releases: { release: string; schemaWrites?: number }[] }>(
          ctx,
          'GET',
          '/v1/operator/releases',
        )
      )?.releases ?? [];
    const schemaOf = (r: string) => {
      const known = releases.find((x) => x.release === r)?.schemaWrites;
      if (typeof known === 'number') return known;
      for (const root of ctx.searchRoots) {
        const f = join(root, r, 'build.json');
        if (existsSync(f))
          return (
            (JSON.parse(readFileSync(f, 'utf8')) as { tuple?: { runtime?: { schemaWrites?: number } } }).tuple
              ?.runtime?.schemaWrites ?? null
          );
      }
      return null;
    };
    // Boxes that would need a checkpoint and have nowhere to put it wait for ever (UP-F1, MD-06).
    unprotected = unprotectedBoxes(devices.devices, notes.migrations, schemaOf);
    if (unprotected.length && !a.allowUnprotected)
      throw new Error(
        `${prod.id} runs a migration that needs a backup checkpoint, and these boxes have no backup destination: ${unprotected.map((u) => `${u.device} (${u.release}, ${u.migrations.join(', ')})`).join('; ')}. They would wait with “needs a backup destination” and change nothing. Ask the person on each box to set one (Settings → This Whombat), or --allow-unprotected to ship anyway.`,
      );
    if (unprotected.length)
      say(
        `--allow-unprotected: ${unprotected.map((u) => u.device).join(', ')} will wait for a backup destination and keep their release`,
      );
    say(`fleet check ok (${devices.devices.filter((d) => d.state === 'claimed').length} claimed devices)`);

    const waves = wavesFor(a.waves, null) ?? ROLLOUT_PRESETS.default;
    process.stdout.write(
      planText({ id: prod.id, cls: build.class, notes, waves, devices: devices.devices, wavesName: a.waves }),
    );
    if (!a.yes) {
      say('nothing done: run again with --yes to publish and roll out');
      return { ok: true, promoted: false, detail: 'plan shown, nothing done' };
    }

    // The ISO of a host release, built now when the build made none (UP-X15): before anything is published.
    const log = join(ctx.logDir, prod.id, 'promote.log');
    let iso: IsoInfo | null = null;
    if (build.class === 'host')
      iso = await ensureIso(ctx, dir, join(ctx.logDir, prod.id, `iso-${prod.id}.log`));

    // Publish, register with the record, roll out; the ISO of a host release.
    const record = releaseRecord({
      env: 'prod',
      twin: build.ship.twin.releaseId,
      notesDir: dir,
      chain,
      builtFrom: await builtFromOf(ctx.repo, build),
      ...(a.withoutValidation
        ? {
            knownIssues: [
              `Promoted without validation (no gates, scenarios or VM upgrade gates): ${a.withoutValidation}`,
            ],
          }
        : {}),
    });
    const recordFile = join(dir, 'record.json');
    writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
    const deployDir = join(ctx.prod.deploySh, '..', '..', '..');
    say(`deploy.sh release ${prod.id} --waves ${a.waves} --record …; log ${log}`);
    const rel = await run(
      ctx.prod.deploySh,
      ['release', prod.id, join(dir, 'release'), '--waves', a.waves, '--record', recordFile],
      {
        cwd: deployDir,
        logFile: log,
        timeoutMs: 3 * 3_600_000,
        echo: true,
      },
    );
    if (rel.code !== 0) throw new Error(`deploy.sh release failed (${rel.code}); see ${log}`);
    if (iso) {
      const r = await run(ctx.prod.deploySh, ['iso', prod.id, iso.path], {
        cwd: deployDir,
        logFile: log,
        timeoutMs: 3_600_000,
        echo: true,
      });
      if (r.code !== 0) throw new Error(`deploy.sh iso failed (${r.code}); see ${log}`);
    }
  }

  // Follow the rollout to its end.
  const res = await follow(ctx, prod.id);
  const rec: ChainedRecord = {
    chain: nextChain(
      dir,
      prod.id,
      'promote',
      {
        twin: build.ship.twin.releaseId,
        ok: res.ok,
        complete: !a.withoutValidation,
        notes: [
          ...(a.withoutValidation ? [`promoted without validation: ${a.withoutValidation}`] : []),
          ...(res.ok ? [] : [res.detail]),
        ],
      },
      after,
    ),
    v: 1,
    waves: a.waves,
    rollout: res.rollout,
    detail: res.detail,
    ...(res.stalled ? { stalled: res.stalled } : {}),
    ...(unprotected.length ? { allowedUnprotected: unprotected } : {}),
    pins: null as string | null,
  };
  if (res.ok) rec.pins = await promotePins(ctx, build.ship.candidate.name, prod.id);
  const sha = writeRecord(dir, 'promote', rec);
  say(`promote.json ${sha.slice(0, 12)}: ${res.ok ? 'completed' : res.detail}`);
  if (!res.ok) process.exitCode = 1;
  return { ok: res.ok, promoted: true, detail: res.detail };
}
