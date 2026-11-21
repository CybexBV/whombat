/**
 * The move of DEV's boxes to the GitHub repository (Whombat LNK-50; the maintainers' dev-instance runbook “The move to
 * GitHub”, `docs/runbooks/updates.md` “The bridge”): what the freeze, the bridge rehearsal on a DEV box VM and the VM's
 * start decide, without I/O. `dev/freeze.ts`, `release/ship publish-dev` and `dev/devbox` use it.
 *
 * Why it matters: DEV control offers a box the release of the open rollout whose waves reach its cohort, else the
 * release of the newest **completed** rollout, whatever the box's cohort (control `computeDesired`). So a rollout
 * that completes offers its release to Home, and a release Home takes during the move is one its rollback from the
 * bridge doesn't know.
 */
import { compareIds, parseReleaseId } from '../ship/ids.ts';

/** A rollout as DEV control's `GET /v1/operator/rollouts` lists it (as much as this reads). */
export interface MoveRollout {
  rollout: string;
  release: string;
  state: string;
  createdAt?: number;
  waves?: readonly { cohorts?: readonly string[] }[];
}

/** A device as `GET /v1/operator/devices` lists it (as much as this reads). */
export interface MoveDevice {
  device: string;
  state: string;
  name?: string | null;
  internal?: boolean;
  lastSeenAt?: number | null;
  status?: { release?: string; update?: { state?: string; candidate?: string | null } };
}

/**
 * The manager's steady states (`Steady()`): the box runs its release and nothing is under way. After a rolled back or
 * quarantined candidate it is back on its known-good release, which control doesn't offer it again (`failed_before`).
 */
export const STEADY = ['Healthy', 'RolledBack', 'Quarantined'];

/** The open rollouts (active or paused): a stop ends them for good, a completion would offer their release to all. */
export const openRollouts = (rollouts: readonly MoveRollout[]) =>
  rollouts.filter((r) => r.state === 'active' || r.state === 'paused');

/**
 * The release DEV control offers a box that no open rollout reaches: the newest completed rollout's (control orders by
 * completion; the operator list has the creation time, and DEV runs one rollout at a time, so the newest created
 * completed one is it).
 */
export function offeredToAll(rollouts: readonly MoveRollout[]): string | null {
  const done = rollouts
    .filter((r) => r.state === 'completed')
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return done[0]?.release ?? null;
}

export interface BoxNow {
  device: string;
  name: string | null;
  release: string | null;
  state: string;
  settled: boolean;
  /** Why not settled, in words; empty when it is. */
  why: string;
}

/** A box not heard from in this long can't be said to be settled (an idle box checks every 15 minutes). */
export const SEEN_WITHIN_S = 3600;

/**
 * Whether every claimed DEV box is settled once no rollout is open: steady, and not behind the release DEV control
 * offers every box (it would take that at its next check, a release its carried list wouldn't have). `ignore` names
 * devices the operator vouched for (one that never reports). Each box's release is what the move carries.
 */
export function settle(
  devices: readonly MoveDevice[],
  rollouts: readonly MoveRollout[],
  nowMs: number,
  ignore: readonly string[] = [],
): { offered: string | null; open: string[]; boxes: BoxNow[]; settled: boolean } {
  const open = openRollouts(rollouts).map((r) => `${r.rollout} (${r.release}, ${r.state})`);
  const offered = offeredToAll(rollouts);
  const target = offered ? parseReleaseId(offered) : null;
  const boxes = devices
    .filter((d) => d.state === 'claimed' && !ignore.includes(d.device))
    .map((d): BoxNow => {
      const release = d.status?.release ?? null;
      const state = d.status?.update?.state ?? 'unknown';
      const seen = d.lastSeenAt ? Math.round(nowMs / 1000 - d.lastSeenAt) : null;
      const cur = release ? parseReleaseId(release) : null;
      let why = '';
      if (seen === null || seen > SEEN_WITHIN_S)
        why = seen === null ? 'never reported' : `not heard from for ${Math.round(seen / 60)} min`;
      else if (!STEADY.includes(state))
        why = `${state}${d.status?.update?.candidate ? ` → ${d.status.update.candidate}` : ''}: an update is under way`;
      else if (state === 'Healthy' && target && (!cur || compareIds(cur, target) < 0))
        why = `${offered} is offered to it and not taken yet`;
      return { device: d.device, name: d.name ?? null, release, state, settled: why === '', why };
    });
  return { offered, open, boxes, settled: open.length === 0 && boxes.every((b) => b.settled) };
}

/** One line per box: what the move carries for it (`gh-continue --carry`), or why it isn't settled. */
export function boxLines(boxes: readonly BoxNow[]): string[] {
  return boxes.map(
    (b) =>
      `${b.name ? `${b.name} (${b.device})` : b.device}: ${b.release ?? 'no release'}, ${b.state}${b.settled ? '' : ` — not settled: ${b.why}`}`,
  );
}

/**
 * The freeze file once the boxes settled: its first line (why, kept as the operator wrote it), then each box's release
 * as `release <device> <release id>` lines, the list `gh-continue --carry` takes.
 */
export function freezeRecord(firstLine: string, boxes: readonly BoxNow[]): string {
  const releases = boxes.filter((b) => b.release).map((b) => `release ${b.device} ${b.release}`);
  return `${[firstLine.trim(), ...releases].join('\n')}\n`;
}

/** The releases the freeze recorded (`release <device> <id>` lines), by device. */
export function recordedReleases(freezeFile: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of freezeFile.split('\n')) {
    const m = /^release (\S+) (\S+)$/.exec(line.trim());
    if (m?.[1] && m[2]) out[m[1]] = m[2];
  }
  return out;
}

/* The rehearsal on the DEV box VM -------------------------------------------------------------------------------- */

/**
 * The rehearsal's waves (`--waves rehearsal`): the internal cohort only (the VM, the only internal device), and an
 * observation window of a week, so control can't complete it, and so offer its release to every box, before
 * `release/ship publish-dev` stops it. Even when that process dies, Home is never offered the release in that week. A
 * wave nobody is eligible for still completes at once (control's `promotable`), so the VM is never retired while the
 * rehearsal's rollout is open (`dev/devbox destroy` refuses).
 */
export const REHEARSAL_HOLD_S = 7 * 24 * 3600;

/** The open rollouts that reach only the internal cohort (a rehearsal, `--rollout <device>`): the VM's. */
export const internalOnlyOpen = (rollouts: readonly MoveRollout[]) =>
  openRollouts(rollouts).filter(
    (r) =>
      (r.waves?.length ?? 0) > 0 &&
      r.waves?.every((w) => w.cohorts?.length === 1 && w.cohorts[0] === 'internal'),
  );

/**
 * How `release/ship publish-dev` ends its rollout: a rehearsal is always stopped (success or failure: its release must
 * never complete), and the stop is checked; a soak that passed stops it too; any other failure leaves it paused for a
 * look, as before.
 */
export function rolloutEnd(waves: string, failed: boolean): 'stop' | 'pause' {
  return waves === 'rehearsal' || !failed ? 'stop' : 'pause';
}

/* The VM's start: where Home is ----------------------------------------------------------------------------------- */

/**
 * What `dev/devbox create --release <id>` installs: a host release's own ISO; for a runtime-only release (Home runs one
 * most of the time) the ISO of the host it runs on (its tuple's host), after which DEV control brings the VM to the
 * release (the one offered to every box). `from` overrides the host to install.
 */
export function installPlan(
  release: string,
  build: { class?: string; tuple?: { host?: { version?: string } | string } } | null,
  from: string | null,
): { iso: string; target: string } {
  if (from) return { iso: from, target: release };
  if (!build) throw new Error(`${release}: no build of it here (give the host to install with --from)`);
  if (build.class === 'host') return { iso: release, target: release };
  const host = typeof build.tuple?.host === 'string' ? build.tuple.host : build.tuple?.host?.version;
  if (!host) throw new Error(`${release} is runtime-only and its build names no host: --from <host release>`);
  return { iso: host, target: release };
}

/**
 * Whether DEV control brings a VM installed from `iso` to `target`: `target` is the release offered to every box (no
 * open rollout), or the VM runs it from the start. Null when it does; else why not.
 */
export function reachesTarget(iso: string, target: string, rollouts: readonly MoveRollout[]): string | null {
  if (iso === target) return null;
  const open = openRollouts(rollouts);
  if (open.length)
    return `a rollout is open (${open.map((r) => `${r.rollout}: ${r.release}`).join(', ')}): the VM would take that`;
  const offered = offeredToAll(rollouts);
  if (offered !== target)
    return `DEV control offers every box ${offered ?? 'nothing'}, not ${target}: the VM would stay on or go to that`;
  return null;
}

/* The VM under a managed lease (agent-resource) -------------------------------------------------------------------- */

/**
 * The `incus` commands that turn an empty VM made by `agent-resource vm-launch --lease <id> --empty --memory 8GiB
 * --cpus 4` into the DEV box's (what `incus init` sets otherwise): stopped, Secure Boot off, the monitor and serial
 * (raw.qemu), the role, the PATH, the root disk grown, the installer attached. The lease owns the instance and removes
 * it when it ends; custom volumes it doesn't own (the installer, the backup disk) `dev/devbox destroy` removes.
 */
export function leasedSetup(o: {
  vm: string;
  rawQemu: string;
  path: string;
  disk: string;
  pool: string;
  isoVolume: string;
}): string[][] {
  return [
    ['stop', o.vm, '--force'],
    ['config', 'set', o.vm, 'security.secureboot=false'],
    ['config', 'set', o.vm, `raw.qemu=${o.rawQemu}`],
    ['config', 'set', o.vm, 'user.whombat.role=dev-box'],
    ['config', 'set', o.vm, `environment.PATH=${o.path}`],
    ['config', 'device', 'override', o.vm, 'root', `size=${o.disk}`],
    [
      'config',
      'device',
      'add',
      o.vm,
      'installer',
      'disk',
      `pool=${o.pool}`,
      `source=${o.isoVolume}`,
      'boot.priority=10',
    ],
  ];
}
