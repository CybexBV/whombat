/**
 * A Windows PC in the servers' fixture world (Whombat windows-servers.md): `office-pc`, a Windows 11 Pro tower with
 * Microsoft Defender on, BitLocker on its Windows drive and off on its data drive, two updates waiting and a restart
 * pending. Its page is built from the-falcon's on every read. Listed in the fleet only when
 * `localStorage['whombat.fixtures.windows']` is set, as studio is, so the mock's five servers stay as drawn; `off` as
 * its value turns the virus protection off (the warning shows). Not imported by production code.
 */
import type { HostServer, HostServerDetail, HostWindowsDetail } from '@whombat/core/domain';
import type { HostsFixtureAnswer, HostsFixtureRequest, HostsFixtureWorld } from './fixtures';

export const WINDOWS_SERVER = 'office-pc';

type Handle = (req: HostsFixtureRequest) => HostsFixtureAnswer | null;

export interface WindowsFixtureContext {
  world: HostsFixtureWorld;
  now: number;
  /** office-pc in the fleet's list; default: `localStorage['whombat.fixtures.windows']` is set. */
  listed?: boolean;
  /** Its virus protection is off. */
  protectionOff?: boolean;
}

function setting(): string | null {
  try {
    return globalThis.localStorage?.getItem('whombat.fixtures.windows') ?? null;
  } catch {
    return null;
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The PC's own facts. */
export function windowsFixtureDetail(now: number, protectionOff = false): HostWindowsDetail {
  return {
    product: 'Windows 11 Pro',
    displayVersion: '24H2',
    build: '26100.2605',
    edition: 'Professional',
    server: false,
    manufacturer: 'Example Computers',
    model: 'Tower 5',
    updatesCheckedAt: new Date(now - 3 * HOUR).toISOString(),
    updatesInstalledAt: new Date(now - 12 * DAY).toISOString(),
    protection: protectionOff
      ? {
          state: 'off',
          product: null,
          defender: {
            running: true,
            mode: 'normal',
            realTime: false,
            tamper: false,
            signaturesAt: new Date(now - 2 * DAY).toISOString(),
            quickScanAt: new Date(now - 3 * DAY).toISOString(),
          },
          antivirus: [{ name: 'Microsoft Defender Antivirus', on: false, upToDate: true }],
        }
      : {
          state: 'on',
          product: 'Microsoft Defender Antivirus',
          defender: {
            running: true,
            mode: 'normal',
            realTime: true,
            tamper: true,
            signaturesAt: new Date(now - 5 * HOUR).toISOString(),
            quickScanAt: new Date(now - DAY).toISOString(),
          },
          antivirus: [{ name: 'Microsoft Defender Antivirus', on: true, upToDate: true }],
        },
    bitlocker: [
      { drive: 'C:', protection: 'on', system: true },
      { drive: 'D:', protection: 'off', system: false },
    ],
  };
}

function pcDetail(t: HostServerDetail, now: number, protectionOff: boolean): HostServerDetail {
  return {
    ...t,
    asOf: new Date(now).toISOString(),
    server: {
      ...t.server,
      id: WINDOWS_SERVER,
      status: protectionOff ? 'warn' : 'ok',
      statusNote: null,
      roles: [],
      os: { name: 'Windows 11 Pro', version: '24H2', kernel: '10.0.26100.2605' },
      osFamily: 'windows',
      cpu: { model: 'AMD Ryzen 7 7700', cores: 8, threads: 16 },
      memory: { totalGb: 32, type: null },
      uptimeS: 9 * 86_400 + 2 * 3600,
      lastBoot: new Date(now - 9 * DAY).toISOString(),
      address: '10.100.1.60',
      location: 'Office',
      platform: 'windows',
    },
    live: t.live
      ? {
          ...t.live,
          cpuPct: 12,
          cpuUserPct: 8.4,
          cpuSystemPct: 3.1,
          cpuIowaitPct: null,
          loadAvg: null,
          memPct: 58,
          memUsedGb: 18.6,
          memCacheGb: null,
          zfsArcGb: null,
          memFreeGb: 13.4,
          swapUsedGb: 1.2,
          swapTotalGb: 8,
        }
      : null,
    banner: null,
    sensors: [],
    disks: [
      {
        device: 'PhysicalDrive0',
        type: 'nvme',
        model: 'Example NVMe 1TB',
        role: 'system',
        capacityGb: 1000,
        usedGb: 412,
        wearPct: null,
        tempC: null,
        health: 'healthy',
        smart: { passed: true },
      },
      {
        device: 'PhysicalDrive1',
        type: 'hdd',
        model: 'Example HDD 4TB',
        role: 'data',
        capacityGb: 4000,
        usedGb: 3310,
        wearPct: null,
        tempC: null,
        health: 'healthy',
        smart: { passed: true },
      },
    ],
    virtualization: null,
    hints: protectionOff
      ? [
          {
            serverId: WINDOWS_SERVER,
            kind: 'windows.protection_off',
            severity: 'warning',
            entity: 'host',
            title: 'Virus protection is off',
            detail: 'Turn on real-time protection in Windows Security → Virus & threat protection',
            section: 'system',
          },
        ]
      : [],
    alerts: [],
    health: t.health
      ? {
          ...t.health,
          system: t.health.system
            ? {
                ...t.health.system,
                packageManager: 'windows_update',
                updates: 2,
                securityUpdates: 1,
                updatesCheckedAt: new Date(now - 3 * HOUR).toISOString(),
                rebootRequired: true,
                initSystem: 'windows',
                failedCount: 0,
                failedUnits: [],
                timeSource: 'time.windows.com',
                processes: 214,
                pressure: null,
                packageTask: null,
                packageLast: null,
              }
            : t.health.system,
          network: [
            {
              name: 'Ethernet',
              kind: 'ethernet',
              up: true,
              carrier: true,
              speedMbps: 1000,
              mtu: 1500,
              addresses: ['10.100.1.60/24'],
              master: null,
              members: [],
              rxMbps: 4,
              txMbps: 1,
              errors: 0,
              drops: 0,
            },
          ],
          volumes: [
            {
              entity: 'fs:C:',
              kind: 'fs',
              label: 'C:',
              usedGb: 412,
              totalGb: 952,
              usedPct: 43,
              fullInDays: null,
              fsType: 'NTFS',
              device: 'C:',
            },
            {
              entity: 'fs:D:',
              kind: 'fs',
              label: 'D: Data',
              usedGb: 3310,
              totalGb: 3726,
              usedPct: 89,
              fullInDays: 41,
              fsType: 'NTFS',
              device: 'D:',
            },
          ],
          arrays: [],
          ups: [],
          gpus: [],
          tasks: [],
        }
      : t.health,
    workloads: {},
    proxmox: undefined,
    incus: undefined,
    unraid: undefined,
    libvirt: undefined,
    macos: undefined,
    windows: windowsFixtureDetail(now, protectionOff),
  };
}

function pcRow(t: HostServer, protectionOff: boolean): HostServer {
  return {
    ...t,
    id: WINDOWS_SERVER,
    name: WINDOWS_SERVER,
    status: protectionOff ? 'warn' : 'ok',
    statusNote: null,
    platform: 'windows',
    osFamily: 'windows',
    os: 'Windows 11 Pro 24H2',
    cpu: { model: 'AMD Ryzen 7 7700', cores: 8, threads: 16 },
    uptimeS: 9 * 86_400 + 2 * 3600,
    cpuPct: 12,
    memory: { usedPct: 58, usedGb: 18.6, totalGb: 32 },
    storage: { usedPct: 80, usedTb: 3.72, capacityTb: 4.68 },
    temperature: null,
    guests: [],
    alerts: { critical: 0, warning: protectionOff ? 1 : 0 },
  };
}

/** Puts office-pc in the web's fixture world; its page is answered from it, the rest goes on to `next`. */
export function withWindows(next: Handle, ctx: WindowsFixtureContext): Handle {
  const { world, now } = ctx;
  const stored = setting();
  const listed = ctx.listed ?? !!stored;
  const off = ctx.protectionOff ?? stored === 'off';
  const template = world.details.get('the-falcon');
  const templateRow = world.servers.find((s) => s.id === 'the-falcon');
  if (!template || !templateRow) return next;
  if (!world.details.has(WINDOWS_SERVER)) {
    world.details.set(WINDOWS_SERVER, pcDetail(template, now, off));
    world.settings.set(WINDOWS_SERVER, {
      ...(world.settings.get('the-falcon') ?? {
        id: WINDOWS_SERVER,
        group: 'Home lab',
        location: null,
        remoteControl: { console: true, power: true },
        agentPolicy: { console: true, power: true },
      }),
      id: WINDOWS_SERVER,
      location: 'Office',
    });
    if (listed) world.servers.push(pcRow(templateRow, off));
  }
  return next;
}
