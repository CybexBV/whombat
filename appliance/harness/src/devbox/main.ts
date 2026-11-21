/**
 * `dev/devbox` — the DEV box (UP-D1…UP-D3; IN-94): an Incus VM on this machine installed from the DEV twin ISO of the
 * current PROD release, self-registered with DEV control, claimed by a DEV org, marked internal. It takes every DEV
 * release through the real update chain (control, the DEV TUF repository at updates-dev.whombat.com, the manager, the
 * helper), which is what `release/ship publish-dev` proves a candidate on.
 *
 *   dev/devbox create [--release <dev id>] [--from <dev host id>] [--iso <file>]
 *                                                           install, register, claim, internal, Healthy on the release
 *                                                           (a runtime-only one: its host's ISO, then DEV control
 *                                                           brings the box to it; --from installs another host)
 *   dev/devbox rebuild [--release <dev id>]                 destroy, then create (never repaired by hand, UP-D3)
 *   dev/devbox claim                                            resume an interrupted create after the install
 *   dev/devbox backup-disk [--size 64GiB]                       the backup disk attached, chosen, a first backup (IN-423)
 *   dev/devbox status [--json]                                  the VM, control's device record, the claim
 *   dev/devbox console [--lines N]                              the serial console (NX-120's state lines among it)
 *   dev/devbox smoke [--out <file>]                             UP-D2's smoke through the relay, as the box's person
 *   dev/devbox soak --for 2h --release <id> [--out <file>]      UP-D2's soak: smoke, watch, smoke
 *   dev/devbox deploy-check [--minutes N] [--out <file>]        an agent deploys a site to a test server (Whombat GF-07)
 *   dev/devbox ra-check [--only a,b] [--minutes N] [--out <file>]  the box's agent, resourceful, as a person uses it (RA-60)
 *   dev/devbox update-status                                    the box's own update status (its manager's `status`):
 *                                                           a box past the bridge reports no status to control
 *   dev/devbox destroy                                          retire the device at control, delete the VM (refused
 *                                                           while a rollout to the internal cohort is open)
 *
 * Inside the box, as root through the DEV image's Incus agent (NX-143; any Whombat in the VM, the tool's own or not):
 *   dev/devbox shell [-- <command…>]                            a root shell, or one command
 *   dev/devbox logs [<unit>…] [-f] [-n N] [--since T]           the journal (`manager` is whombat-manager)
 *   dev/devbox diag [--out <dir>]                               units, failures, journal, memory, disk, network
 *   dev/devbox port <port> [<path>] [--lan]                     GET a port on the box from inside it (e.g. 20000);
 *                                                               --lan (always for 4480) at its LAN address
 *
 * Under a managed lease (`WB_DEVBOX_LEASE`, `WB_DEVBOX_VM`, `WB_DEVBOX_INCUS_PROJECT`, `WB_DEVBOX_POOL`; incus.ts):
 * `create` makes the empty VM the lease launched into the DEV box, and `destroy` retires the device and removes the
 * volumes; the VM itself goes with `agent-resource release <lease>`.
 *
 * Defaults: `--release` is the twin of the newest release on https://updates.whombat.com (its build.json's
 * `ship.twin`, or a dev build.json whose `ship.twinOf` names it); the ISO is the release directory's (`iso.json`, else
 * build.json's `iso`), built first with `release/build iso` under the heavy lock when the build made none
 * (UP-X15).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installPlan, internalOnlyOpen, type MoveRollout, reachesTarget } from '../dev/move.ts';
import { HARNESS_DIR } from '../lib/paths.ts';
import { run, sleep } from '../lib/proc.ts';
import { validateDuration } from '../ship/args.ts';
import { findBuild, findTwin } from '../ship/build.ts';
import { devControl, devOp, publishedReleaseIds, shipContext } from '../ship/context.ts';
import { compareIds, idsFromTargets, parseReleaseId } from '../ship/ids.ts';
import { ensureIso } from '../ship/iso.ts';
import { type BackupDiskResult, backupDisk, DEFAULT_BACKUP_DISK_SIZE } from './backup-disk.ts';
import { device, deviceBySerial, devices } from './control.ts';
import {
  agentReady,
  BACKUP_VOLUME,
  boxExec,
  boxExecAttached,
  consoleState,
  createVm,
  customVolumes,
  deleteBackupVolume,
  deleteIso,
  deleteVm,
  importIso,
  journalArgs,
  LEASE,
  pressKeys,
  removeInstaller,
  serialLog,
  startVm,
  stopVm,
  typeText,
  VM,
  vmAddress,
  vmInfo,
  vmState,
} from './incus.ts';
import { raCheckTimeoutMs, selectedScenarios } from './ra-rules.ts';
import { DEVBOX_HOME, type DevboxState, loadState, publicView, retireState, saveState } from './state.ts';

const say = (s: string) => process.stderr.write(`devbox: ${s}\n`);
const ctx = shipContext();

export const MONITOR_PORT = Number(process.env.WB_DEVBOX_MONITOR_PORT ?? 5801);
const OWNER = { email: 'dev-box@devbox.whombat.local', name: 'Dev box' };

async function waitUntil<T>(
  label: string,
  ms: number,
  every: number,
  probe: () => Promise<T | null | undefined | false>,
): Promise<T> {
  const until = Date.now() + ms;
  let last = '';
  for (;;) {
    try {
      const v = await probe();
      if (v) return v;
    } catch (err) {
      last = ` (${(err as Error).message.split('\n')[0]})`;
    }
    if (Date.now() > until) throw new Error(`${label}: not within ${Math.round(ms / 60_000)} min${last}`);
    await sleep(every);
  }
}

/** The DEV twin of the newest PROD release (UP-D1). */
async function defaultRelease(): Promise<string> {
  const prod = (await publishedReleaseIds(ctx.prod.updatesUrl)) ?? [];
  const newest = prod
    .map(parseReleaseId)
    .filter((r) => r?.env === 'prod')
    .sort((a, b) => compareIds(b as NonNullable<typeof b>, a as NonNullable<typeof a>))[0];
  if (!newest)
    throw new Error(`can't read production's releases from ${ctx.prod.updatesUrl}: --release <dev id>`);
  const twin = findTwin(ctx, newest.id);
  if (!twin) throw new Error(`no DEV twin of ${newest.id} is built here: build it, or --release <dev id>`);
  return twin;
}

/** The release's ISO: given, or the release directory's, built now when the build made none (UP-X15). */
async function isoOf(release: string, given: string | null): Promise<string> {
  if (given) return given;
  const b = findBuild(ctx, release);
  if (!b) throw new Error(`${release}: no release directory here (${ctx.searchRoots.join(', ')})`);
  if (b.build.class !== 'host')
    throw new Error(
      `${release} is runtime-only: it has no ISO (install its host's, --release ${String((b.build.tuple as { host?: { version?: string } } | undefined)?.host?.version ?? '<host release>')})`,
    );
  mkdirSync(join(DEVBOX_HOME, 'logs'), { recursive: true });
  return (await ensureIso(ctx, b.dir, join(DEVBOX_HOME, 'logs', `iso-${release}.log`))).path;
}

async function isoSha256(iso: string): Promise<string> {
  const r = await run('sha256sum', [iso], { cwd: process.cwd(), timeoutMs: 600_000 });
  const sha = r.stdout.split(' ')[0] ?? '';
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`sha256sum ${iso} failed: ${r.stderr.trim()}`);
  return sha;
}

/** The release is published in DEV's repository and approved by DEV control: a box installed from it can update. */
async function checkPublished(release: string): Promise<void> {
  const rel = join(ctx.dev.tuf, 'targets', 'releases');
  const ids = existsSync(rel) ? idsFromTargets(readdirSync(rel).map((f) => `releases/${f}`)) : [];
  if (!ids.includes(release))
    throw new Error(
      `${release} is not in DEV's repository: dev/publish-release it before the box boots (release-build.md)`,
    );
  const { releases } = await devOp<{ releases: { release: string; state: string }[] }>(
    devControl(ctx),
    'GET',
    '/releases',
  );
  const r = releases.find((x) => x.release === release);
  if (r?.state !== 'approved')
    throw new Error(`DEV control has ${release} as ${r?.state ?? 'unknown'}, not approved`);
}

/** Runs one task of session.devbox.ts (the real client needs vitest's aliases); its result JSON. */
async function sessionTask(
  task: 'claim' | 'smoke' | 'soak' | 'deploy-check' | 'deploy-inspect' | 'ra-check',
  env: Record<string, string>,
  outFile?: string,
): Promise<Record<string, unknown>> {
  const logs = join(DEVBOX_HOME, 'logs');
  mkdirSync(logs, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '');
  const out = outFile ?? join(logs, `${task}-${stamp}.json`);
  const log = join(logs, `${task}-${stamp}.log`);
  say(`${task}: through the real client (log ${log})`);
  const soakS = Number(env.WB_DEVBOX_SOAK_S ?? 0);
  const r = await run(
    'pnpm',
    ['exec', 'vitest', 'run', '--config', 'vitest.devbox.config.ts', 'src/devbox/session.devbox.ts'],
    {
      cwd: HARNESS_DIR,
      env: { ...env, WB_DEVBOX_TASK: task, WB_DEVBOX_OUT: out, WB_DEV_HOME: ctx.dev.home },
      logFile: log,
      timeoutMs:
        soakS * 1000 +
        3_600_000 +
        Number(env.WB_DEPLOY_MINUTES ?? 0) * 60_000 +
        (task === 'ra-check' ? raCheckTimeoutMs(env) : 0),
    },
  );
  if (!existsSync(out)) {
    const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-25).join('\n');
    throw new Error(`${task} produced no result (exit ${r.code}); ${log}\n${tail}`);
  }
  return JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
}

/** Boots the installer ISO and installs onto the VM's disk through the second VT's shell (see incus.ts). */
async function install(): Promise<void> {
  await startVm();
  say('installer booting; waiting for its shell on the second VT');
  await sleep(40_000);
  let ready = false;
  for (let i = 1; i <= 24 && !ready; i++) {
    const mark = `WBDEVBOX-READY-${i}`;
    await pressKeys(MONITOR_PORT, 'ctrl-alt-f2');
    await sleep(1500);
    await typeText(MONITOR_PORT, `sudo sh -c 'echo ${mark} $(lsblk -dnbo SIZE /dev/sda) >/dev/ttyS0'\n`);
    const until = Date.now() + 15_000;
    while (Date.now() < until && !ready) {
      const m = new RegExp(`${mark} (\\d+)`).exec(await serialLog());
      if (m?.[1]) {
        ready = true;
        say(`installer shell ready (/dev/sda ${Math.round(Number(m[1]) / 2 ** 30)} GiB)`);
      } else await sleep(2000);
    }
    if (!ready) await sleep(10_000);
  }
  if (!ready)
    throw new Error(
      'the installer never answered on its second VT (dev/devbox console shows the serial log)',
    );
  await typeText(
    MONITOR_PORT,
    "sudo sh -c 'whombat-install --disk /dev/sda --yes-erase-disk >/dev/ttyS0 2>&1; echo WBDEVBOX-INSTALL-EXIT=$? >/dev/ttyS0'\n",
  );
  say('whombat-install --disk /dev/sda running (its log goes to the serial console)');
  const exit = await waitUntil('whombat-install', 45 * 60_000, 10_000, async () => {
    const m = /WBDEVBOX-INSTALL-EXIT=(\d+)/.exec(await serialLog());
    return m?.[1] ?? null;
  });
  if (exit !== '0') {
    const tail = (await serialLog()).split('\n').slice(-30).join('\n');
    throw new Error(`whombat-install exited ${exit}:\n${tail}`);
  }
  say('installed; powering off to boot from the disk');
  await typeText(MONITOR_PORT, 'sudo poweroff\n');
  try {
    await waitUntil('poweroff', 180_000, 3000, async () => (await vmState()) === 'STOPPED');
  } catch {
    await stopVm(true);
  }
  await removeInstaller();
  await deleteIso();
  await startVm();
}

async function create(a: { release: string | null; iso: string | null; from: string | null }): Promise<void> {
  const state = await vmState();
  if (LEASE) {
    // The lease launched the VM empty: it must not be a DEV box already (VM settings below are set once).
    if (state === 'ABSENT')
      throw new Error(`${VM} isn't there: agent-resource vm-launch --lease ${LEASE} --empty …`);
    const role = await vmInfo().then(
      (v) => (v?.config as Record<string, string> | undefined)?.['user.whombat.role'],
    );
    if (role)
      throw new Error(`${VM} is a DEV box already: destroy it and release the lease, then launch another`);
  } else if (state !== 'ABSENT') throw new Error(`${VM} exists: dev/devbox rebuild (or destroy) first`);
  const c = devControl(ctx);
  const asked = a.release ?? (await defaultRelease());
  if (parseReleaseId(asked)?.env !== 'dev')
    throw new Error(`${asked} is not a DEV release (whombat-dev-YYYYMMDD.N)`);
  // Where Home is: a runtime-only release is installed from its host's ISO, then DEV control brings the box to it, which
  // it does only when that release is the one offered to every box (the newest completed rollout, none open).
  const plan = installPlan(
    asked,
    (findBuild(ctx, asked)?.build ?? null) as Parameters<typeof installPlan>[1],
    a.from,
  );
  const release = plan.iso;
  if (parseReleaseId(release)?.env !== 'dev')
    throw new Error(`${release} is not a DEV release (whombat-dev-YYYYMMDD.N)`);
  await checkPublished(release);
  if (plan.target !== release) {
    await checkPublished(plan.target);
    const { rollouts } = await devOp<{ rollouts: MoveRollout[] }>(c, 'GET', '/rollouts');
    const why = reachesTarget(release, plan.target, rollouts);
    if (why) throw new Error(`a box installed from ${release} wouldn't reach ${plan.target}: ${why}`);
    say(`installing ${release}; DEV control then brings the box to ${plan.target}`);
  }
  const iso = await isoOf(release, a.iso);
  say(`${release}: ${iso}`);
  const sha = await isoSha256(iso);
  const sums = join(iso, '..', 'SHA256SUMS');
  if (existsSync(sums) && !readFileSync(sums, 'utf8').includes(sha))
    throw new Error(`${iso} doesn't match its SHA256SUMS`);
  const internalOthers = (await devices(c)).filter((d) => d.internal && d.state !== 'retired');
  if (internalOthers.length)
    throw new Error(
      `other devices are internal on DEV and would take every DEV rollout: ${internalOthers.map((d) => d.device).join(', ')}`,
    );
  const serial = `WBDEVBOX-${randomBytes(6).toString('hex').toUpperCase()}`;
  const st: DevboxState = {
    v: 1,
    vm: VM,
    serial,
    monitorPort: MONITOR_PORT,
    installedFrom: { releaseId: release, iso, isoSha256: sha },
    ...(plan.target !== release ? { target: plan.target } : {}),
    ...(LEASE ? { lease: LEASE } : {}),
    createdAt: new Date().toISOString(),
    owner: { ...OWNER, org: loadState()?.owner.org ?? '' },
  };
  saveState(st);
  say(`creating ${VM} (serial ${serial}, 4 vCPU, 8 GiB, 128 GiB, monitor 127.0.0.1:${MONITOR_PORT})`);
  await importIso(iso);
  await createVm({ serial, monitorPort: MONITOR_PORT, cpus: 4, memory: '8GiB', disk: '128GiB' });
  await install();

  await finish(st);
  process.stdout.write(`${JSON.stringify(publicView(st))}\n`);
}

/** After the install: registration, the claim code, the claim, internal, Healthy (`create`, and `claim` to resume). */
async function finish(st: DevboxState): Promise<void> {
  const c = devControl(ctx);
  const release = st.target ?? st.installedFrom.releaseId;
  const serial = st.serial;
  say('first boot: self-provisioning and self-registration with DEV control');
  const d = await waitUntil('self-registration', 25 * 60_000, 10_000, () => deviceBySerial(c, serial));
  st.device = d.device;
  st.peerId = d.contentPeerId ?? '';
  saveState(st);
  say(`registered: ${d.device} (${d.origin ?? 'self'})`);
  const code = await waitUntil('the claim code on the serial console', 15 * 60_000, 5000, async () => {
    const s = consoleState(await serialLog());
    return s?.state === 'claimable' && s.code ? s.code : null;
  });
  say('claim code read from the serial console (NX-120)');
  const claimed = await sessionTask('claim', { WB_DEVBOX_LETTERS: code });
  // The task saved the person's endpoint, recovery kit and org in the state file: take them before saving again.
  Object.assign(st, loadState());
  say(`claimed by ${OWNER.email} (${String(claimed.org)})`);
  await devOp(c, 'PUT', `/devices/${d.device}/internal`, { internal: true });
  st.internalAt = new Date().toISOString();
  saveState(st);
  say(`${d.device} is internal (wave 0 of every DEV rollout)`);
  // A box that is to take another release first waits for its next check of control (an idle one: every 15 minutes).
  await waitUntil(`Healthy on ${release}`, (st.target ? 60 : 20) * 60_000, 10_000, async () => {
    const x = await device(c, d.device);
    return x?.status?.release === release && x.status.update?.state === 'Healthy';
  });
  st.healthyAt = new Date().toISOString();
  saveState(st);
  say(`${d.device} Healthy on ${release}`);
  // A backup destination before the first contract migration needs its checkpoint (IN-423, Whombat HE-53).
  try {
    await withBackupDisk(st, DEFAULT_BACKUP_DISK_SIZE);
  } catch (err) {
    say(`the backup disk isn't set up: ${(err as Error).message} (dev/devbox backup-disk tries again)`);
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(publicView(st))}\n`);
}

/** `backup-disk`, and the last step of `create`: the result in the state file, `protected` or an error. */
async function withBackupDisk(st: DevboxState, size: string): Promise<BackupDiskResult> {
  const r = await backupDisk(st.serial, size, say);
  st.backupDisk = {
    volume: r.volume,
    at: new Date().toISOString(),
    state: r.after.state,
    snapshotId: r.after.lastSuccess?.snapshotId ?? null,
  };
  saveState(st);
  if (!r.protected)
    throw new Error(
      `the backup status is ${r.after.state}${r.after.lastFailure ? `: ${r.after.lastFailure.reason}` : ''}`,
    );
  return r;
}

async function destroy(): Promise<string | null> {
  const st = loadState();
  const c = devControl(ctx);
  // A rollout to the internal cohort (the bridge rehearsal's) completes at once when nobody is eligible any more, and a
  // completed rollout's release is offered to every box, Home included: it is stopped before the box goes.
  const { rollouts } = await devOp<{ rollouts: MoveRollout[] }>(c, 'GET', '/rollouts');
  const open = internalOnlyOpen(rollouts);
  if (open.length)
    throw new Error(
      `a rollout to the internal cohort is open (${open.map((r) => `${r.rollout}: ${r.release}, ${r.state}`).join('; ')}); retiring the box would complete it and offer its release to every box. Stop it first: POST ${c.adminUrl}/v1/operator/rollouts/<id>/stop {"reason":"dev_box_destroyed"}`,
    );
  if (st?.device) {
    const d = await device(c, st.device);
    if (d && d.state !== 'retired') {
      await devOp(c, 'POST', `/devices/${st.device}/retire`, { reason: 'dev_box_destroyed' });
      say(`${st.device} retired at DEV control`);
    }
  }
  if (LEASE) {
    // The lease owns the VM and removes it at its end; the volumes made here it doesn't own.
    await stopVm(true);
    await deleteIso();
    await deleteBackupVolume();
    retireState();
    say(`${VM} stopped and its volumes removed; the VM goes with: agent-resource release ${LEASE}`);
    return st?.installedFrom.releaseId ?? null;
  }
  await deleteVm();
  await deleteIso();
  retireState();
  const kept = (await customVolumes()).some((v) => v.name === BACKUP_VOLUME);
  say(
    `${VM} deleted${kept ? `; ${BACKUP_VOLUME} kept (the old box's backups: the next create renames it aside)` : ''}`,
  );
  return st?.installedFrom.releaseId ?? null;
}

async function status(json: boolean): Promise<void> {
  const st = loadState();
  const vm = await vmInfo();
  const d = st?.device ? await device(devControl(ctx), st.device).catch(() => null) : null;
  const view = {
    vm: vm ? { name: vm.name, status: vm.status } : null,
    device: d
      ? {
          device: d.device,
          state: d.state,
          internal: d.internal ?? false,
          lastSeenAt: d.lastSeenAt,
          status: d.status,
        }
      : null,
    state: st ? publicView(st) : null,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    return;
  }
  const s = d?.status;
  const lines = [
    `VM        ${vm ? `${VM} ${String(vm.status)}` : 'none'}`,
    `device    ${d ? `${d.device} ${d.state}${d.internal ? ' internal' : ''}` : st?.device ? `${st.device} (not at control)` : 'none'}`,
    `release   ${s?.release ?? '—'} · update ${s?.update?.state ?? '—'}${s?.update?.candidate ? ` → ${s.update.candidate}` : ''}${s?.update?.failure ? ` · failure ${s.update.failure}` : ''}`,
    `health    ${
      s?.health
        ? Object.entries(s.health)
            .map(([k, v]) => `${k} ${v}`)
            .join(' · ')
        : '—'
    }`,
    `manager   ${s?.managerVersion ?? '—'} · last seen ${d?.lastSeenAt ? new Date(d.lastSeenAt * 1000).toISOString() : '—'}`,
    `address   ${(await vmAddress()) ?? '— (no Incus agent answering, NX-143)'}`,
    `installed ${st ? `${st.installedFrom.releaseId} on ${st.createdAt}` : '—'} · claimed by ${st?.owner.email ?? '—'} (${st?.owner.org || '—'})`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** What `dev/devbox diag` collects, one file each: state only, no conversations or secrets. */
const DIAG: [file: string, script: string][] = [
  [
    'units.txt',
    "systemctl --no-pager --failed; echo; systemctl --no-pager list-units --all 'whombat-*' 'postgresql*'",
  ],
  [
    'system.txt',
    'uname -a; uptime; echo; cat /etc/whombat/platform; readlink /run/current-system; echo; free -m; echo; ' +
      'df -h -x tmpfs -x devtmpfs; echo; cat /proc/pressure/memory /proc/pressure/cpu /proc/pressure/io',
  ],
  ['journal-whombat.txt', "journalctl --no-pager -o short-iso --since -2h -u 'whombat-*'"],
  ['journal-warnings.txt', 'journalctl --no-pager -o short-iso --since -24h -p warning'],
  ['journal-boots.txt', 'journalctl --no-pager --list-boots | tail -n 20'],
  ['network.txt', 'ip -br addr; echo; ip route; echo; ip -6 route'],
];

async function diag(out: string | null): Promise<void> {
  await agentReady();
  const dir = out ?? join(DEVBOX_HOME, 'diag', new Date().toISOString().replace(/[:.]/g, ''));
  mkdirSync(dir, { recursive: true });
  for (const [file, script] of DIAG) {
    const r = await boxExec(['sh', '-c', script], 300_000);
    writeFileSync(join(dir, file), `$ ${script}\n${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`);
  }
  const failed =
    readFileSync(join(dir, 'units.txt'), 'utf8').match(/^(\d+) loaded units listed/m)?.[1] ?? '0';
  say(`${failed} failed unit(s); ${DIAG.length} files in ${dir}`);
  process.stdout.write(`${dir}\n`);
}

function arg(argv: string[], k: string): string | null {
  const i = argv.indexOf(k);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const [cmd, ...argv] = process.argv.slice(2);
  switch (cmd) {
    case 'create':
      await create({ release: arg(argv, '--release'), iso: arg(argv, '--iso'), from: arg(argv, '--from') });
      break;
    case 'rebuild': {
      if (LEASE)
        throw new Error('a leased box is not rebuilt: destroy it, release the lease, launch another');
      const was = await destroy();
      await create({ release: arg(argv, '--release') ?? was, iso: arg(argv, '--iso'), from: null });
      break;
    }
    case 'update-status': {
      // The box's own word (the manager's status command): past the bridge a box with Link reports no status to control
      // (support heartbeats instead), so control's device record keeps the release it had before.
      await agentReady();
      const r = await boxExec(
        [
          'runuser',
          '-u',
          'whombat-manager',
          '--',
          'whombat-manager',
          '--config',
          '/etc/whombat/manager.json',
          'status',
        ],
        120_000,
      );
      process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      process.exitCode = r.code ?? 1;
      break;
    }
    case 'destroy':
      await destroy();
      break;
    case 'claim': {
      const st = loadState();
      if (!st || (await vmState()) !== 'RUNNING')
        throw new Error('no running DEV box to claim (dev/devbox create)');
      await finish(st);
      break;
    }
    case 'status':
      await status(argv.includes('--json'));
      break;
    case 'backup-disk': {
      const st = loadState();
      if (!st) throw new Error('no DEV box in the state file (dev/devbox create)');
      const r = await withBackupDisk(st, arg(argv, '--size') ?? DEFAULT_BACKUP_DISK_SIZE);
      const { before, after, ...rest } = r;
      const view = {
        ...rest,
        before: before.state,
        after: { state: after.state, lastSuccess: after.lastSuccess },
      };
      process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
      break;
    }
    case 'shell': {
      await agentReady();
      const i = argv.indexOf('--');
      const cmd = i >= 0 ? argv.slice(i + 1) : [];
      process.exitCode = await boxExecAttached(cmd.length ? cmd : ['bash', '-l']);
      break;
    }
    case 'logs': {
      await agentReady();
      const n = arg(argv, '-n');
      const since = arg(argv, '--since');
      const units = argv.filter(
        (x, i) => !x.startsWith('-') && !['-n', '--since'].includes(argv[i - 1] ?? ''),
      );
      const follow = argv.includes('-f');
      process.exitCode = await boxExecAttached(
        journalArgs({ units, follow, lines: n === null ? null : Number(n), since }),
      );
      break;
    }
    case 'diag':
      await diag(arg(argv, '--out'));
      break;
    case 'port': {
      const [port, path = '/'] = argv.filter((a) => a !== '--lan');
      if (!port || !/^\d+$/.test(port)) throw new Error('dev/devbox port <port> [<path>] [--lan]');
      await agentReady();
      // The direct listener (Whombat DC-03) answers on the LAN and tailscale0, never on the box's loopback: GET it at
      // the box's LAN address from inside (the connection still arrives on the LAN card's address).
      const lan = await vmAddress();
      const viaLan = argv.includes('--lan') || port === '4480';
      if (viaLan && !lan) throw new Error('the box has no LAN address yet (dev/devbox status)');
      const host = viaLan ? (lan ?? '') : '127.0.0.1';
      const url = `http://${host}:${port}${path.startsWith('/') ? path : `/${path}`}`;
      const r = await boxExec(['curl', '-sS', '-i', '-m', '15', url], 60_000);
      process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      if (lan) say(`from your LAN: http://${lan}:${port}${path.startsWith('/') ? path : `/${path}`}`);
      process.exitCode = r.code ?? 1;
      break;
    }
    case 'console': {
      const n = Number(arg(argv, '--lines') ?? 60);
      process.stdout.write(`${(await serialLog()).split('\n').slice(-n).join('\n')}\n`);
      break;
    }
    case 'deploy-check': {
      // The test web server (deploy-check/Dockerfile) on this machine, reachable from the box at the incus bridge's
      // gateway; the Vault's public key for `deploy` lands in a folder it mounts.
      const keys = join(DEVBOX_HOME, 'deploy-check-keys');
      mkdirSync(keys, { recursive: true });
      const name = 'whombat-deploy-check-web';
      await run('docker', ['rm', '-f', name], { cwd: HARNESS_DIR });
      await run('docker', ['build', '-q', '-t', name, join(HARNESS_DIR, 'src/devbox/deploy-check')], {
        cwd: HARNESS_DIR,
      });
      const started = await run(
        'docker',
        [
          'run',
          '-d',
          '--name',
          name,
          '-p',
          '2222:22',
          '-p',
          '8088:80',
          '-v',
          `${keys}:/etc/ssh/authorized_keys:ro`,
          name,
        ],
        { cwd: HARNESS_DIR },
      );
      if (started.code !== 0) throw new Error(`the test web server didn't start: ${started.stderr}`);
      const minutes = arg(argv, '--minutes') ?? '40';
      const signIn = join(DEVBOX_HOME, 'deploy-check-signin.txt');
      say(`deploy-check: a person approves the ChatGPT sign-in written to ${signIn} (once per box)`);
      try {
        const r = await sessionTask(
          'deploy-check',
          {
            WB_DEPLOY_KEYS: keys,
            WB_DEPLOY_MINUTES: minutes,
            WB_DEPLOY_SIGNIN_FILE: signIn,
            WB_DEPLOY_HOST: process.env.WB_DEPLOY_HOST ?? '10.62.52.1',
          },
          arg(argv, '--out') ?? undefined,
        );
        for (const s of (r.steps as { name: string; ok: boolean; ms: number }[]) ?? [])
          say(`${s.ok ? 'ok  ' : 'FAIL'} ${s.name} (${s.ms} ms)`);
        process.exitCode = r.ok ? 0 : 1;
      } finally {
        if (!argv.includes('--keep-server')) await run('docker', ['rm', '-f', name], { cwd: HARNESS_DIR });
      }
      break;
    }
    case 'ra-check': {
      // Whombat RA-60 on the box: the scanned invoice first (Pillow through uv), then the scenarios as the person.
      const only = arg(argv, '--only') ?? '';
      selectedScenarios(only); // an unknown name stops here
      const dir = join(DEVBOX_HOME, 'ra-check');
      mkdirSync(dir, { recursive: true });
      const invoice = join(dir, 'invoice.jpg');
      const made = await run(
        'uv',
        [
          'run',
          '--quiet',
          '--with',
          'pillow',
          'python3',
          join(HARNESS_DIR, 'src/devbox/ra-check/invoice.py'),
          invoice,
        ],
        { cwd: HARNESS_DIR, timeoutMs: 300_000 },
      );
      if (made.code !== 0 || !existsSync(invoice))
        throw new Error(`the scanned invoice wasn't made (uv run --with pillow): ${made.stderr.trim()}`);
      const r = await sessionTask(
        'ra-check',
        {
          WB_RA_INVOICE: invoice,
          WB_RA_ONLY: only,
          WB_RA_SCENARIO_MINUTES: arg(argv, '--minutes') ?? process.env.WB_RA_SCENARIO_MINUTES ?? '15',
          WB_RA_LAN_HOST: process.env.WB_RA_LAN_HOST ?? '10.62.52.1',
        },
        arg(argv, '--out') ?? undefined,
      );
      for (const s of (r.setup as { name: string; ok: boolean; ms: number }[]) ?? [])
        if (!s.ok) say(`FAIL ${s.name} (${s.ms} ms)`);
      type Sc = {
        name: string;
        ok: boolean;
        seconds: number;
        withoutHelp: boolean;
        questions: string[];
        tokens: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | null;
      };
      for (const s of (r.scenarios as Sc[]) ?? [])
        say(
          `${s.ok ? 'ok  ' : 'FAIL'} ${s.name} (${s.seconds} s; ${s.withoutHelp ? 'without help' : 'helped'}; ${s.questions.length} question${s.questions.length === 1 ? '' : 's'}; ${s.tokens ? `${s.tokens.inputTokens} in${s.tokens.cacheReadTokens === undefined ? '' : ` (${s.tokens.cacheReadTokens} cached)`} / ${s.tokens.outputTokens} out tokens` : 'tokens unknown'})`,
        );
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'deploy-inspect': {
      const r = await sessionTask('deploy-inspect', {}, arg(argv, '--out') ?? undefined);
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      break;
    }
    case 'smoke': {
      const r = await sessionTask('smoke', {}, arg(argv, '--out') ?? undefined);
      for (const s of (r.steps as { name: string; ok: boolean; ms: number }[]) ?? [])
        say(`${s.ok ? 'ok  ' : 'FAIL'} ${s.name} (${s.ms} ms)`);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'soak': {
      const release = arg(argv, '--release') ?? loadState()?.installedFrom.releaseId;
      if (!release) throw new Error('--release <id>');
      const seconds = Math.round(validateDuration(arg(argv, '--for') ?? '2h') / 1000);
      const r = await sessionTask(
        'soak',
        { WB_DEVBOX_RELEASE: release, WB_DEVBOX_SOAK_S: String(seconds) },
        arg(argv, '--out') ?? undefined,
      );
      say(
        `soak ${r.ok ? 'ok' : `FAILED: ${(r.reasons as string[]).join('; ')}`} (${String(r.observedS)} s, ${String(r.samples)} samples)`,
      );
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    default:
      process.stderr.write(
        `${readFileSync(new URL(import.meta.url), 'utf8')
          .split('*/')[0]
          ?.replace(/^\/\*\*\n/, '')
          .replace(/^ \* ?/gm, '')}\n`,
      );
      process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`devbox: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
