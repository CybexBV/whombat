/**
 * The DEV box's VM (UP-D1, IN-94): an Incus VM on this machine, created, driven and removed through the `incus` CLI.
 * Only the instance `whombat-dev-box` and its installer volume are ever touched.
 *
 * The installer is driven through a QEMU human monitor on a loopback TCP port (`raw.qemu -monitor`): `sendkey` types
 * on the installer's second VT (an autologin shell on the ISO), and what the commands print goes to the serial
 * console, which `incus console --show-log` returns (the screen itself is only reachable as SPICE). The installed dev
 * image writes its console state there too (NX-120).
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { leasedSetup } from '../dev/move.ts';
import { must, run, sleep } from '../lib/proc.ts';

/**
 * A temporary DEV box (the bridge rehearsal, the maintainers' dev-instance runbook “The move to GitHub”) lives under a
 * managed lease on this machine: `agent-resource vm-launch --lease <id> --empty …` makes the VM in its Incus project,
 * and the lease removes it when it ends, even when this tool doesn't. `WB_DEVBOX_LEASE` (the lease id), `WB_DEVBOX_VM`
 * (the VM the lease made) and `WB_DEVBOX_INCUS_PROJECT` (`agent-tasks`) say so; `WB_DEVBOX_POOL` is that project's pool.
 */
export const LEASE = process.env.WB_DEVBOX_LEASE?.trim() || null;
export const PROJECT = process.env.WB_DEVBOX_INCUS_PROJECT?.trim() || null;
export const VM = process.env.WB_DEVBOX_VM?.trim() || 'whombat-dev-box';
export const ISO_VOLUME = 'whombat-dev-box-installer';
export const POOL = process.env.WB_DEVBOX_POOL ?? 'default';
if (LEASE && (!PROJECT || !process.env.WB_DEVBOX_VM))
  throw new Error(
    'WB_DEVBOX_LEASE needs WB_DEVBOX_VM (what agent-resource vm-launch printed) and WB_DEVBOX_INCUS_PROJECT (agent-tasks)',
  );
const projectArgs = PROJECT ? ['--project', PROJECT] : [];

export interface VmSpec {
  serial: string;
  monitorPort: number;
  cpus: number;
  memory: string;
  disk: string;
}

/** The VM settings of install.md §5: q35, OVMF without enrolled keys, virtio, the i6300esb watchdog. */
export function rawQemu(s: VmSpec): string {
  return [
    '-device i6300esb -action watchdog=reset',
    // The box's hardware serial (whombat-provision reads product_serial): how the tool finds its device record.
    `-smbios type=1,serial=${s.serial}`,
    `-monitor tcp:127.0.0.1:${s.monitorPort},server=on,wait=off`,
  ].join(' ');
}

const incus = (args: string[], timeoutMs = 600_000) =>
  run('incus', [...projectArgs, ...args], { cwd: process.cwd(), timeoutMs });
const incusMust = (args: string[], timeoutMs = 600_000) =>
  must('incus', [...projectArgs, ...args], { cwd: process.cwd(), timeoutMs });

export async function vmState(): Promise<'RUNNING' | 'STOPPED' | 'ABSENT' | string> {
  const r = await incus(['list', `^${VM}$`, '--format', 'json']);
  if (r.code !== 0) throw new Error(`incus list: ${r.stderr.trim()}`);
  const list = JSON.parse(r.stdout) as { name: string; status: string }[];
  const vm = list.find((x) => x.name === VM);
  return vm ? vm.status.toUpperCase() : 'ABSENT';
}

export async function vmInfo(): Promise<Record<string, unknown> | null> {
  const r = await incus(['list', `^${VM}$`, '--format', 'json']);
  const list = JSON.parse(r.stdout || '[]') as Record<string, unknown>[];
  return list.find((x) => x.name === VM) ?? null;
}

/** The VM's IPv4 address on this machine's Incus bridge (eth0 first), as Incus reports it; null when it has none. */
export async function vmAddress(): Promise<string | null> {
  const vm = await vmInfo();
  type Nic = { addresses?: { family: string; address: string; scope: string }[] };
  const nics = (vm?.state as { network?: Record<string, Nic> } | null | undefined)?.network ?? {};
  const names = Object.keys(nics).sort((a, b) => Number(b === 'eth0') - Number(a === 'eth0'));
  for (const name of names) {
    if (name === 'lo' || /^(wbc|incusbr|veth|docker|br-)/.test(name)) continue;
    const a = nics[name]?.addresses?.find((x) => x.family === 'inet' && x.scope === 'global');
    if (a) return a.address;
  }
  return null;
}

export async function importIso(iso: string): Promise<void> {
  const has = await incus(['storage', 'volume', 'show', POOL, `custom/${ISO_VOLUME}`]);
  if (has.code === 0) await incusMust(['storage', 'volume', 'delete', POOL, `custom/${ISO_VOLUME}`]);
  await incusMust(['storage', 'volume', 'import', POOL, iso, ISO_VOLUME, '--type=iso'], 1_800_000);
}

export async function deleteIso(): Promise<void> {
  const has = await incus(['storage', 'volume', 'show', POOL, `custom/${ISO_VOLUME}`]);
  if (has.code === 0) await incusMust(['storage', 'volume', 'delete', POOL, `custom/${ISO_VOLUME}`]);
}

export async function createVm(s: VmSpec): Promise<void> {
  if (LEASE) {
    // The lease made the VM (empty, started): make it the DEV box's, as `incus init` below would.
    for (const args of leasedSetup({
      vm: VM,
      rawQemu: rawQemu(s),
      path: BOX_PATH,
      disk: s.disk,
      pool: POOL,
      isoVolume: ISO_VOLUME,
    }))
      await incusMust(args);
    return;
  }
  const init = [
    'init',
    VM,
    '--empty',
    '--vm',
    '-c',
    `limits.cpu=${s.cpus}`,
    '-c',
    `limits.memory=${s.memory}`,
    '-c',
    'security.secureboot=false',
    '-c',
    `raw.qemu=${rawQemu(s)}`,
    '-c',
    'user.whombat.role=dev-box',
    '-c',
    `environment.PATH=${BOX_PATH}`,
    '-d',
    `root,size=${s.disk}`,
  ];
  // A deleted VM's ZFS dataset can outlive `incus delete` by a few seconds (“dataset already exists”).
  for (let i = 0; ; i++) {
    const r = await incus(init);
    if (r.code === 0) break;
    if (i >= 12 || !/already exists|busy/.test(r.stderr))
      throw new Error(`incus init ${VM}: ${r.stderr.trim()}`);
    await sleep(10_000);
  }
  await incusMust([
    'config',
    'device',
    'add',
    VM,
    'installer',
    'disk',
    `pool=${POOL}`,
    `source=${ISO_VOLUME}`,
    'boot.priority=10',
  ]);
}

export async function removeInstaller(): Promise<void> {
  const r = await incus(['config', 'device', 'show', VM]);
  if (r.code === 0 && /^installer:/m.test(r.stdout))
    await incusMust(['config', 'device', 'remove', VM, 'installer']);
}

/* The backup disk (BK-20, IN-423) ---------------------------------------------------------------------------- */

/** The box's backup disk: a custom block volume in the VM's pool, attached as the device `backup`. */
export const BACKUP_VOLUME = `${VM}-backup`;
export const BACKUP_DEVICE = 'backup';
/** How the attached volume shows inside the VM (Incus names the SCSI disk after the device). */
export const BACKUP_DISK_IN_BOX = `/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_incus_${BACKUP_DEVICE}`;

export interface VolumeInfo {
  name: string;
  description: string;
  usedBy: string[];
  createdAt: string;
}

/** The pool's custom volumes. */
export async function customVolumes(): Promise<VolumeInfo[]> {
  const r = await incus(['storage', 'volume', 'list', POOL, '--format', 'json']);
  if (r.code !== 0) throw new Error(`incus storage volume list ${POOL}: ${r.stderr.trim()}`);
  type V = { name: string; type: string; description?: string; used_by?: string[]; created_at?: string };
  return (JSON.parse(r.stdout) as V[])
    .filter((v) => v.type === 'custom')
    .map((v) => ({
      name: v.name,
      description: v.description ?? '',
      usedBy: v.used_by ?? [],
      createdAt: v.created_at ?? '',
    }));
}

/** The description that ties a backup volume to the box it was made for (its hardware serial). */
export const backupVolumeDescription = (serial: string) =>
  `dev/devbox: the backup disk of ${serial} (BK-20, IN-423)`;

export const createBackupVolume = (serial: string, size: string) =>
  incusMust([
    'storage',
    'volume',
    'create',
    POOL,
    BACKUP_VOLUME,
    '--type=block',
    `size=${size}`,
    '--description',
    backupVolumeDescription(serial),
  ]);

/**
 * A leased box's backup volume, detached and deleted (`dev/devbox destroy` under a lease): the lease removes the VM but
 * not the custom volumes made in its project, and that box's backups are a rehearsal's, not anybody's data.
 */
export async function deleteBackupVolume(): Promise<void> {
  const devices = await incus(['config', 'device', 'show', VM]);
  if (devices.code === 0 && new RegExp(`^${BACKUP_DEVICE}:`, 'm').test(devices.stdout))
    await incusMust(['config', 'device', 'remove', VM, BACKUP_DEVICE]);
  const has = await incus(['storage', 'volume', 'show', POOL, `custom/${BACKUP_VOLUME}`]);
  if (has.code === 0) await incusMust(['storage', 'volume', 'delete', POOL, `custom/${BACKUP_VOLUME}`]);
}

/** Renames a previous box's backup volume out of the way: its repository is kept, never deleted. */
export const renameVolume = (from: string, to: string) =>
  incusMust(['storage', 'volume', 'rename', POOL, from, to]);

/** The VM's device `backup`'s source volume, or null when it has no such device. */
export async function backupDeviceSource(): Promise<string | null> {
  const r = await incus(['config', 'device', 'show', VM]);
  if (r.code !== 0) throw new Error(`incus config device show ${VM}: ${r.stderr.trim()}`);
  if (!new RegExp(`^${BACKUP_DEVICE}:`, 'm').test(r.stdout)) return null;
  const s = await incusMust(['config', 'device', 'get', VM, BACKUP_DEVICE, 'source']);
  return s.stdout.trim();
}

/** Attaches the backup volume; to a running VM as a hot-plug (Incus supports it for a VM's disks). */
export async function attachBackupVolume(): Promise<void> {
  const r = await incus([
    'config',
    'device',
    'add',
    VM,
    BACKUP_DEVICE,
    'disk',
    `pool=${POOL}`,
    `source=${BACKUP_VOLUME}`,
  ]);
  if (r.code === 0) return;
  throw new Error(
    `incus couldn't attach ${BACKUP_VOLUME} to ${VM} (${r.stderr.trim()}). If it can't be hot-plugged: ` +
      `incus stop ${VM}, incus config device add ${VM} ${BACKUP_DEVICE} disk pool=${POOL} source=${BACKUP_VOLUME}, ` +
      `incus start ${VM}, then dev/devbox backup-disk again`,
  );
}

export const startVm = () => incusMust(['start', VM]);

export async function stopVm(force = false): Promise<void> {
  if ((await vmState()) !== 'RUNNING') return;
  await incusMust(['stop', VM, ...(force ? ['--force'] : ['--timeout', '120'])]);
}

export async function deleteVm(): Promise<void> {
  // ZFS answers “dataset is busy” for a few seconds after QEMU exits: try again.
  for (let i = 0; ; i++) {
    if ((await vmState()) === 'ABSENT') return;
    const r = await incus(['delete', VM, '--force']);
    if (r.code === 0) return;
    if (i >= 6 || !/busy/.test(r.stderr)) throw new Error(`incus delete ${VM}: ${r.stderr.trim()}`);
    await sleep(5000);
  }
}

/** The serial console's log (the ring buffer QEMU keeps; the whole boot's output). */
export async function serialLog(): Promise<string> {
  const r = await incus(['console', VM, '--show-log'], 60_000);
  return r.code === 0 ? r.stdout : '';
}

/** The newest `whombat-dev-console: state=… code=…` line (NX-120). */
export function consoleState(log: string): { state: string; code: string | null } | null {
  const lines = [...log.matchAll(/whombat-dev-console: state=([a-z]+) code=([A-Z-]+|-)/g)];
  const last = lines.at(-1);
  if (!last?.[1]) return null;
  return { state: last[1], code: last[2] && last[2] !== '-' ? last[2] : null };
}

/* Inside the box (NX-143) ----------------------------------------------------------------------------------- */

const NO_AGENT = /VM agent isn't currently running|agent.*not.*running/i;

/**
 * NixOS's PATH for commands in the box: `incus exec` otherwise gives Incus's default (`/usr/bin`, `/bin`), where NixOS
 * has only `env` and `sh`. Also the VM's `environment.PATH`, so a plain `incus exec` finds the system's tools.
 */
export const BOX_PATH = '/run/wrappers/bin:/run/current-system/sw/bin';

/**
 * The DEV image's Incus agent answers (NX-143). An image from before it has none: a host release of this appliance
 * commit or later gives it one.
 */
export async function agentReady(): Promise<void> {
  const state = await vmState();
  if (state !== 'RUNNING') throw new Error(`${VM} is ${state.toLowerCase()}, not running`);
  const r = await incus(['exec', VM, '--', 'true'], 30_000);
  if (r.code === 0) return;
  if (NO_AGENT.test(r.stderr))
    throw new Error(
      `${VM} has no Incus agent: its image predates NX-143 (give it a DEV host release built from this commit on)`,
    );
  throw new Error(`incus exec ${VM}: ${r.stderr.trim()}`);
}

/** A command in the box as root, its output captured. */
export const boxExec = (cmd: string[], timeoutMs = 120_000) =>
  incus(['exec', VM, '--env', `PATH=${BOX_PATH}`, '--', ...cmd], timeoutMs);

/** A command in the box as root with this terminal attached (a shell, `journalctl -f`); its exit code. */
export function boxExecAttached(cmd: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('incus', [...projectArgs, 'exec', VM, '--env', `PATH=${BOX_PATH}`, '--', ...cmd], {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** A unit name for journalctl: `manager` is `whombat-manager`; full names, globs and the system's own units stay. */
export function unitName(name: string): string {
  if (/[.*?[]/.test(name) || name.startsWith('whombat-')) return name;
  if (/^(incus|postgresql|systemd-|chronyd|nftables|docker|containerd)/.test(name)) return name;
  return `whombat-${name}`;
}

/** `dev/devbox logs` → journalctl's arguments. */
export function journalArgs(a: {
  units: string[];
  follow: boolean;
  lines: number | null;
  since: string | null;
}) {
  return [
    'journalctl',
    '--no-pager',
    '-o',
    'short-iso',
    ...a.units.flatMap((u) => ['-u', unitName(u)]),
    ...(a.since ? ['--since', a.since] : []),
    '-n',
    String(a.lines ?? (a.follow ? 50 : 200)),
    ...(a.follow ? ['-f'] : []),
  ];
}

/* Typing through the monitor -------------------------------------------------------------------------------- */

const NAMED: Record<string, string> = {
  ' ': 'spc',
  '\n': 'ret',
  '-': 'minus',
  _: 'shift-minus',
  '=': 'equal',
  '+': 'shift-equal',
  '/': 'slash',
  '?': 'shift-slash',
  '.': 'dot',
  '>': 'shift-dot',
  ',': 'comma',
  '<': 'shift-comma',
  ';': 'semicolon',
  ':': 'shift-semicolon',
  "'": 'apostrophe',
  '"': 'shift-apostrophe',
  '\\': 'backslash',
  '|': 'shift-backslash',
  '`': 'grave_accent',
  '~': 'shift-grave_accent',
  '[': 'bracket_left',
  ']': 'bracket_right',
  '{': 'shift-bracket_left',
  '}': 'shift-bracket_right',
  '!': 'shift-1',
  '@': 'shift-2',
  '#': 'shift-3',
  $: 'shift-4',
  '%': 'shift-5',
  '^': 'shift-6',
  '&': 'shift-7',
  '*': 'shift-8',
  '(': 'shift-9',
  ')': 'shift-0',
};

/** QEMU `sendkey` names for text on a US keyboard (the ISO's layout). */
export function keysFor(text: string): string[] {
  return [...text].map((ch) => {
    if (/^[a-z0-9]$/.test(ch)) return ch;
    if (/^[A-Z]$/.test(ch)) return `shift-${ch.toLowerCase()}`;
    const k = NAMED[ch];
    if (!k) throw new Error(`can't type ${JSON.stringify(ch)}`);
    return k;
  });
}

/** Sends monitor commands one by one (the monitor answers each with its prompt). */
export async function monitor(port: number, commands: string[], gapMs = 40): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sock = connect({ host: '127.0.0.1', port });
    sock.on('error', reject);
    sock.on('data', () => {});
    sock.on('connect', async () => {
      try {
        await sleep(300);
        for (const c of commands) {
          sock.write(`${c}\n`);
          await sleep(gapMs);
        }
        await sleep(300);
        sock.end();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

export const typeText = (port: number, text: string) =>
  monitor(
    port,
    keysFor(text).map((k) => `sendkey ${k} 30`),
    60,
  );

export const pressKeys = (port: number, ...combos: string[]) =>
  monitor(
    port,
    combos.map((k) => `sendkey ${k} 100`),
    400,
  );
