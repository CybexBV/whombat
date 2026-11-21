/**
 * `release/ship publish-dev <prod id>` (UP-D1, UP-D2; IN-94, IN-98): the candidate's DEV twin through the real update
 * chain onto the DEV box, then the soak.
 *
 * 1. build.json (dev-soak.json follows it, not validate's records: publish-dev runs while `validate` does, IN-115);
 *    the DEV box (dev/devbox) claimed, internal, Healthy on an older release;
 * 2. `dev/publish-release` of the twin into the DEV TUF repository, registered with DEV control **with its record**,
 *    and rolled out with `--waves default` (UP-E1; the DEV box is internal, so wave 0);
 * 3. waits until the box is Healthy on the twin, or fails with what control says (the device's failure and its
 *    detail, the rollout's pause reason);
 * 4. pauses the rollout (reason `dev_soak`): DEV's later waves would reach only the DEV stack's own appliance, which
 *    runs a fake activator and can't install a NixOS release (IN-98); soaks (`dev/devbox soak`, UP-D2); stops the
 *    rollout (`dev_soak_done`), so the next candidate can start one;
 * 5. `dev-soak.json`, and the record's `gates.devSoak` at control.
 *
 * `--waves rehearsal` (the bridge rehearsal, the maintainers' dev-instance runbook “The move to GitHub”): the internal
 * cohort only, held a week (dev/move.ts), and stopped at the end whatever happened, the stop checked: a completed
 * rollout's release is offered to every box, Home included. While the candidate freeze is on (that move) every other
 * `--waves` is refused.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRetryableUpdateFailure } from '@whombat/release';
import { freezeFile, freezeMessage } from '../dev/candidate-plan.ts';
import { rolloutEnd } from '../dev/move.ts';
import { device as deviceOf } from '../devbox/control.ts';
import { loadState } from '../devbox/state.ts';
import { REPO_DIR } from '../lib/paths.ts';
import { run, sleep } from '../lib/proc.ts';
import { devControl, devOp, OperatorError, type ShipContext, say } from './context.ts';
import { compareIds, parseReleaseId, prodId } from './ids.ts';
import { builtFromOf, describeFailure, describePause, gateSummary, releaseRecord } from './record.ts';
import {
  type ChainedRecord,
  doneRecord,
  nextChain,
  type Verified,
  verifyChain,
  writeRecord,
} from './records.ts';

const FAILED = ['Failed', 'RolledBack', 'Quarantined', 'ForwardRepairRequired'];
/**
 * Steady states in which the box runs its current release (the manager's `Steady()`): after a rolled back or quarantined
 * candidate it is back on its known-good release until the next assignment, so the next candidate may go to it.
 */
const STEADY = ['Healthy', 'RolledBack', 'Quarantined'];

/** A device as `GET /v1/operator/rollouts/<id>/devices` shows it: its update.progress for the rollout's release. */
interface RolloutDevice {
  device: string;
  state: string | null;
  failure: string | null;
}

interface Rollout {
  rollout: string;
  release: string;
  state: string;
  currentWave?: number;
  pauseReason?: string | null;
  pauseDetail?: Record<string, unknown> | null;
}

/**
 * The records the release record at control summarises: build.json and whatever of validate's branch has passed so
 * far (it runs in parallel, IN-115).
 */
export function recordChain(dir: string, releaseId: string): Verified[] {
  for (const upTo of ['upgrade-gates', 'gates', 'build'] as const) {
    const r = doneRecord(dir, releaseId, upTo);
    if (r.chain) return r.chain;
  }
  return verifyChain(dir, releaseId, 'build');
}

export async function publishDev(
  ctx: ShipContext,
  a: { prodId: string; soakMs: number; waves: string; waitMs: number },
): Promise<{ ok: boolean; detail: string }> {
  const prod = prodId(a.prodId);
  const dir = join(ctx.root, prod.id);
  verifyChain(dir, prod.id, 'build');
  const chain = recordChain(dir, prod.id);
  const build = chain[0]?.record as ChainedRecord & {
    source: { rev: string };
    runtime: { whombatRev: string };
    ship: {
      twin: { releaseId: string; dir: string; devAllowDowngradeFrom?: string[] };
      candidate: { file: string };
      contracts?: string;
    };
  };
  const twin = build.ship.twin.releaseId;
  const twinDir = build.ship.twin.dir;
  const c = devControl(ctx);
  const freeze = freezeFile(process.env, homedir());
  if (a.waves !== 'rehearsal' && existsSync(freeze))
    throw new Error(
      `${freezeMessage(freeze, readFileSync(freeze, 'utf8'))} (the bridge rehearsal runs with --waves rehearsal)`,
    );

  // 1. The DEV box.
  const st = loadState();
  if (!st?.device) throw new Error('no DEV box: dev/devbox create');
  const box = await deviceOf(c, st.device);
  if (box?.state !== 'claimed')
    throw new Error(`the DEV box ${st.device} is ${box?.state ?? 'unknown to control'}: dev/devbox rebuild`);
  if (!box.internal) throw new Error(`the DEV box ${st.device} isn't internal: dev/devbox rebuild`);
  const current = box.status?.release ?? '';
  const startState = box.status?.update?.state ?? 'unknown';
  if (!STEADY.includes(startState) || box.status?.health?.runtime !== 'ok')
    throw new Error(
      `the DEV box is ${startState} on ${current} (runtime ${box.status?.health?.runtime ?? 'unknown'}): dev/devbox status`,
    );
  // A rolled back or quarantined candidate before this one (e.g. a bad release) is history, not this twin's failure.
  const earlierCandidate = startState === 'Healthy' ? null : (box.status?.update?.candidate ?? null);
  const cur = parseReleaseId(current);
  const next = parseReleaseId(twin);
  if (cur && next && compareIds(cur, next) >= 0)
    throw new Error(`the DEV box already runs ${current}, not older than ${twin}`);
  say(`DEV box ${st.device}: Healthy on ${current}; delivering ${twin} (twin of ${prod.id})`);

  // 2. Publish, register with the record, roll out.
  const record = releaseRecord({
    env: 'dev',
    twin: prod.id,
    notesDir: twinDir,
    chain,
    builtFrom: await builtFromOf(ctx.repo, build),
  });
  const allowDown = build.ship.twin.devAllowDowngradeFrom ?? [];
  if (allowDown.length) {
    (record as { allowDowngradeFrom?: string[] }).allowDowngradeFrom = allowDown;
    say(`DEV custody: ${twin} may be older than ${allowDown.join(', ')} (UP-X11)`);
  }
  const recordFile = join(twinDir, 'record.json');
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  const log = join(ctx.logDir, prod.id, 'publish-dev.log');
  say(`publish-release ${twin} --waves ${a.waves} --rollout ${st.device}; log ${log}`);
  const pub = await run(
    process.execPath,
    [
      join(REPO_DIR, 'harness', 'src', 'dev', 'publish-release.ts'),
      join(twinDir, 'release'),
      '--record',
      recordFile,
      '--waves',
      a.waves,
      '--rollout',
      st.device,
      // UP-X11: the twin of a PROD release after DEV-only rehearsals went ahead of the line (build --dev-allow-…).
      ...(allowDown.length ? ['--allow-downgrade-from', allowDown.join(',')] : []),
      '--json',
    ],
    { cwd: REPO_DIR, env: { WB_MGD_HOME: ctx.dev.home }, logFile: log, timeoutMs: 3_600_000 },
  );
  if (pub.code !== 0)
    throw new Error(
      `dev/publish-release failed (${pub.code}): ${pub.stderr.trim().split('\n').slice(-5).join(' ')}`,
    );
  const outcome = JSON.parse(pub.stdout.trim().split('\n').at(-1) ?? '{}') as {
    tupleDigest: string;
    record: string | null;
    rollout: { rollout: string } | null;
    blobsAdded?: number;
    bytesAdded?: number;
  };
  const rolloutId = outcome.rollout?.rollout;
  if (!rolloutId) throw new Error('dev/publish-release started no rollout');
  say(
    `published (${outcome.tupleDigest})${typeof outcome.blobsAdded === 'number' ? `, ${outcome.blobsAdded} blobs added (${Math.round((outcome.bytesAdded ?? 0) / 1e6)} MB)` : ''}, record ${outcome.record ?? 'none'}, rollout ${rolloutId}`,
  );

  // 3. Healthy on the twin, or the failure as control has it.
  const started = Date.now();
  const rollout = async () =>
    (await devOp<{ rollouts: Rollout[] }>(c, 'GET', '/rollouts')).rollouts.find(
      (r) => r.rollout === rolloutId,
    );
  // The box's update.progress for the twin, as the rollout shows it (MG-61): the device record's status.report came
  // up to control's 15-minute report interval after the box was Healthy (managers before MG-61 report only then).
  const progress = async () =>
    (await devOp<{ devices: RolloutDevice[] }>(c, 'GET', `/rollouts/${rolloutId}/devices`)).devices.find(
      (x) => x.device === st.device,
    );
  let healthyAt: number | null = null;
  let failure: string | null = null;
  let lastState = '';
  while (Date.now() - started < a.waitMs) {
    const [d, p] = await Promise.all([
      deviceOf(c, st.device).catch(() => null),
      progress().catch(() => undefined),
    ]);
    const u = d?.status?.update;
    const retry = u?.failure && isRetryableUpdateFailure(u.failure) ? ` (retrying after ${u.failure})` : '';
    const line = `${d?.status?.release ?? '?'} ${u?.state ?? '?'}${u?.candidate ? ` → ${u.candidate}` : ''}${retry}; ${twin} ${p?.state ?? '—'}${p?.failure ? ` (${p.failure})` : ''}`;
    if (line !== lastState) {
      say(`DEV box: ${line} (${Math.round((Date.now() - started) / 1000)} s)`);
      lastState = line;
    }
    if (
      (p?.state === 'Healthy' && !p.failure) ||
      (d?.status?.release === twin && u?.state === 'Healthy' && !u.failure)
    ) {
      healthyAt = Date.now();
      break;
    }
    if (p?.state && FAILED.includes(p.state) && !(p.failure && isRetryableUpdateFailure(p.failure))) {
      failure = `the DEV box is ${p.state} on ${twin}${p.failure ? `: ${p.failure}` : ''}${u ? ` (${describeFailure(u)})` : ''}`;
      break;
    }
    const aboutThis =
      u?.candidate === twin || d?.status?.release === twin || u?.candidate !== earlierCandidate;
    if (u?.state && FAILED.includes(u.state) && aboutThis) {
      failure = `the DEV box is ${u.state}: ${describeFailure(u)}`;
      break;
    }
    const r = await rollout().catch(() => undefined);
    if (r?.state === 'paused' || r?.state === 'stopped') {
      failure = `rollout ${rolloutId} is ${r.state}: ${describePause(r)}`;
      break;
    }
    await sleep(10_000);
  }
  if (!healthyAt && !failure)
    failure = `the DEV box wasn't Healthy on ${twin} within ${Math.round(a.waitMs / 60_000)} min (an idle box picks a rollout up at its next poll of control, ROLLOUT_CHECK_IDLE_S; --wait gives it longer)`;

  // 4. Keep DEV at wave 0 while it soaks, soak, then close the rollout.
  let soak: Record<string, unknown> | null = null;
  const soakOut = join(dir, 'dev-soak.devbox.json');
  if (healthyAt) {
    say(
      `Healthy on ${twin} after ${Math.round((healthyAt - started) / 1000)} s; pausing ${rolloutId} at wave 0 for the soak`,
    );
    await devOp(c, 'POST', `/rollouts/${rolloutId}/pause`, { reason: 'dev_soak' }).catch((err: unknown) => {
      say(`couldn't pause ${rolloutId}: ${(err as Error).message}`);
    });
    const soakLog = join(ctx.logDir, prod.id, 'dev-soak.log');
    say(
      a.soakMs > 0
        ? `soak ${Math.round(a.soakMs / 60_000)} min (smoke at the start and the end); log ${soakLog}`
        : `smoke on the Healthy box (no soak period); log ${soakLog}`,
    );
    await run(
      'node',
      [
        join(REPO_DIR, 'harness', 'src', 'devbox', 'main.ts'),
        'soak',
        '--for',
        `${Math.round(a.soakMs / 1000)}s`,
        '--release',
        twin,
        '--out',
        soakOut,
      ],
      { cwd: REPO_DIR, logFile: soakLog, timeoutMs: a.soakMs + 3 * 3_600_000 },
    );
    soak = existsSync(soakOut)
      ? (JSON.parse(readFileSync(soakOut, 'utf8')) as Record<string, unknown>)
      : null;
    if (!soak) failure = `the soak left no result; see ${soakLog}`;
    else if (!soak.ok) failure = `the soak failed: ${(soak.reasons as string[]).join('; ')}`;
  }
  // Done: stop it (DEV's later waves would reach only the dev stack's appliance, IN-98). Failed: leave it paused for
  // whoever looks next (the admin panel, `release/ship status --dev`), as production's pause stays; pause it first if
  // it is still active.
  // A rehearsal is stopped whatever happened, and the stop checked (dev/move.ts `rolloutEnd`).
  const end = rolloutEnd(a.waves, failure !== null);
  const r = await rollout().catch(() => undefined);
  if (r && (r.state === 'active' || r.state === 'paused')) {
    if (end === 'stop') {
      const reason = failure ? 'dev_rehearsal_failed' : 'dev_soak_done';
      await devOp(c, 'POST', `/rollouts/${rolloutId}/stop`, { reason }).catch((err: unknown) => {
        say(`couldn't stop ${rolloutId}: ${(err as Error).message}`);
      });
      say(`rollout ${rolloutId} stopped (${reason})`);
    } else {
      if (r.state === 'active')
        await devOp(c, 'POST', `/rollouts/${rolloutId}/pause`, { reason: 'dev_publish_failed' }).catch(
          (err: unknown) => say(`couldn't pause ${rolloutId}: ${(err as Error).message}`),
        );
      say(
        `rollout ${rolloutId} left paused for inspection (admin panel, release/ship status --dev); the next publish-dev needs it stopped: POST ${c.adminUrl}/v1/operator/rollouts/${rolloutId}/stop {"reason":"…"}`,
      );
    }
  }

  if (a.waves === 'rehearsal') {
    const after = await rollout().catch(() => undefined);
    if (after?.state !== 'stopped') {
      const stopIt = `POST ${c.adminUrl}/v1/operator/rollouts/${rolloutId}/stop {"reason":"dev_rehearsal_done"}`;
      say(
        `ROLLOUT ${rolloutId} IS ${after?.state ?? 'UNKNOWN'}, NOT STOPPED: stop it by hand now (${stopIt}); once it completes, its release is offered to every box`,
      );
      failure = failure ?? `rollout ${rolloutId} is ${after?.state ?? 'unknown'}, not stopped: ${stopIt}`;
    } else say(`rollout ${rolloutId}: stopped, checked; no other box is offered ${twin}`);
  }

  // 5. The record.
  const ok = failure === null;
  const rec: ChainedRecord = {
    chain: nextChain(dir, prod.id, 'dev-soak', {
      twin,
      ok,
      // No minimum soak (UP-D2 as amended by John, 2026-09-29): the box Healthy on the twin and the smoke passing is the
      // proof; `--soak <duration>` watches longer when someone wants it.
      complete: true,
      notes: [...(failure ? [failure] : [])],
    }),
    v: 1,
    device: st.device,
    from: current,
    rollout: {
      id: rolloutId,
      waves: a.waves,
      final: (await rollout().catch(() => undefined))?.state ?? null,
    },
    record: outcome.record,
    healthyAfterS: healthyAt ? Math.round((healthyAt - started) / 1000) : null,
    soak,
  };
  const sha = writeRecord(dir, 'dev-soak', rec);
  say(`dev-soak.json ${sha.slice(0, 12)}: ${ok ? 'ok' : `FAILED — ${failure}`}`);
  try {
    // validate's records as they are now (it ran alongside), and this one.
    const now = releaseRecord({
      env: 'dev',
      twin: prod.id,
      notesDir: twinDir,
      chain: recordChain(dir, prod.id),
      builtFrom: record.builtFrom,
    });
    record.gates = { ...now.gates, devSoak: gateSummary('dev-soak', rec, sha) };
    await devOp(c, 'PUT', `/releases/${twin}/record`, record);
  } catch (err) {
    if (!(err instanceof OperatorError) || ![400, 404, 405].includes(err.status)) throw err;
  }
  if (!ok) process.exitCode = 1;
  return { ok, detail: ok ? `dev-soak.json ${sha.slice(0, 12)}` : (failure ?? 'failed') };
}
