/**
 * The machine's hardware (hardware-support-web.md AP-3213…AP-3220): the problems first in HD-11's words, the groups,
 * the machine's line, and the report text — its facts, aligned columns, and no serials or MAC addresses.
 */
import { describe, expect, it } from 'vitest';
import { type HardwareDevice, HostHardware, hardwareProblems } from './contract';
import { FAKE_MACHINES, fakeHardware } from './fake';
import {
  formatLinkSpeed,
  hardwareMachineName,
  hardwareReportFileName,
  hardwareReportText,
  hardwareSectionView,
  hardwareSpecs,
  hardwareStatusText,
} from './hardware';

const NOW = Date.parse('2026-10-20T09:22:00Z');

describe('the fixture machines', () => {
  it('are hardware reports as the contract has them', () => {
    for (const m of FAKE_MACHINES) expect(() => HostHardware.parse(fakeHardware(m, NOW))).not.toThrow();
  });
});

describe('HARDWARE', () => {
  it('puts the Wi-Fi card without a driver first, in HD-11’s words', () => {
    const v = hardwareSectionView(fakeHardware('nodriver', NOW));
    expect(v.problems.map((p) => [p.kind, p.meta])).toEqual([
      ['wifi', 'This Wi-Fi card has no driver yet.'],
      ['bluetooth', 'This Bluetooth adapter is switched off.'],
    ]);
    expect(v.problems[0]?.dot).toBe('bad');
    expect(v.problems[1]?.dot).toBe('warn');
  });

  it('orders problems Wi-Fi, wired, sound, graphics, then as reported', () => {
    const d = (kind: HardwareDevice['kind'], name: string): HardwareDevice => ({
      kind,
      name,
      bus: 'pci',
      driver: null,
      status: 'no_driver',
    });
    const order = hardwareProblems({
      devices: [d('usb', 'a'), d('graphics', 'b'), d('sound', 'c'), d('camera', 'd'), d('wifi', 'e')],
    }).map((x) => x.name);
    expect(order).toEqual(['e', 'c', 'b', 'a', 'd']);
    expect(hardwareStatusText({ kind: 'wifi', status: 'no_firmware' })).toBe(
      'This Wi-Fi card needs firmware that isn’t there.',
    );
    expect(hardwareStatusText({ kind: 'wifi', status: 'ok' })).toBeNull();
  });

  it('groups the devices in their order, with what each does', () => {
    const v = hardwareSectionView(fakeHardware('z13', NOW));
    expect(v.problems).toEqual([]);
    expect(v.groups.map((g) => g.label)).toEqual([
      'Network',
      'Sound',
      'Graphics & screens',
      'Storage',
      'Power',
      'Other',
    ]);
    const network = v.groups[0]?.rows ?? [];
    expect(network.map((r) => r.driver)).toEqual(['mt7925e', 'r8152', 'btusb']);
    expect(network[1]?.meta).toBe('Realtek · Connected · 1 Gbit/s');
    const mic = v.groups[1]?.rows.find((r) => r.title.includes('microphone'));
    expect(mic?.meta).toBe('AMD · 1 input');
    expect(v.groups[3]?.rows[0]?.meta).toContain('TB');
  });

  it('names the machine, or the virtual machine and its hypervisor', () => {
    const z13 = hardwareSectionView(fakeHardware('z13', NOW));
    expect(z13.machine).toContain('ROG Flow Z13');
    expect(z13.machineMeta).toContain('16 cores, 32 threads');
    expect(z13.machineMeta).toContain('Linux 6.18.53');
    expect(hardwareMachineName(fakeHardware('vm', NOW))).toBe('Virtual machine (KVM)');
  });

  it('words link speeds', () => {
    expect([100, 1000, 2500, 10_000].map((m) => formatLinkSpeed(m))).toEqual([
      '100 Mbit/s',
      '1 Gbit/s',
      '2.5 Gbit/s',
      '10 Gbit/s',
    ]);
  });
});

describe('the machine’s facts as tiles', () => {
  it('says the processor, memory, all disks together and the system', () => {
    const h = fakeHardware('z13', NOW);
    const specs = hardwareSpecs(h);
    expect(specs.map((s) => s.key)).toEqual(['cpu', 'memory', 'storage', 'system']);
    expect(specs[0]).toMatchObject({ label: 'Processor', value: h.cpu.model });
    expect(specs[0]?.line).toContain('cores');
    expect(specs[3]?.value).toContain(h.kernel);
  });

  it('leaves out storage when no disk says its size', () => {
    const h = fakeHardware('z13', NOW);
    const specs = hardwareSpecs({ ...h, devices: h.devices.filter((d) => d.kind !== 'storage') });
    expect(specs.map((s) => s.key)).toEqual(['cpu', 'memory', 'system']);
  });
});

describe('the report', () => {
  const about = { burrow: 'Burrow HQ', version: 'app 0.105.0 · Whombat 0.120.0' };

  it('carries the header, machine, devices with their drivers and ids, and the kernel lines', () => {
    const text = hardwareReportText(fakeHardware('nodriver', NOW), about);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Whombat hardware report');
    expect(text).toContain('Burrow HQ');
    expect(text).toContain('app 0.105.0');
    expect(text).toContain('2026-10-20 09:22 UTC');
    expect(text).toContain('Minisforum MS-A1');
    expect(text).toContain('Problems (2)');
    expect(text).toContain('This Wi-Fi card has no driver yet.');
    const wifi = lines.find((l) => l.startsWith('wifi'));
    expect(wifi).toContain('8086:272b');
    expect(wifi).toContain('NO DRIVER');
    expect(text).toContain('Kernel messages (2)');
    expect(text).toContain('no driver bound');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('aligns the device columns', () => {
    const lines = hardwareReportText(fakeHardware('z13', NOW), about).split('\n');
    const head = lines.findIndex((l) => l.startsWith('KIND'));
    const at = (line: string) => line.indexOf('  ') + 2 + line.slice(line.indexOf('  ') + 2).search(/\S/);
    const nameColumn = at(lines[head] as string);
    for (const l of lines.slice(head + 1, head + 6)) expect(at(l)).toBe(nameColumn);
    expect(lines.every((l) => l === l.trimEnd())).toBe(true);
  });

  it('has nothing that looks like a MAC address or a serial number', () => {
    for (const m of FAKE_MACHINES) {
      const text = hardwareReportText(fakeHardware(m, NOW), about);
      expect(text).not.toMatch(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i);
      expect(text.toLowerCase()).not.toContain('serial');
    }
  });

  it('is named by the day it was collected', () => {
    expect(hardwareReportFileName(fakeHardware('vm', NOW))).toBe('whombat-hardware-2026-10-20.txt');
    expect(hardwareReportFileName({ collectedAt: '2026-10-20T23:30:00Z' }, 'Europe/Amsterdam')).toBe(
      'whombat-hardware-2026-10-21.txt',
    );
  });
});
