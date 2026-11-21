/** Contracts 0.102.0: the box's hardware report, its network and Wi-Fi over the session (CT-560…CT-572). */

import { describe, expect, it } from 'vitest';
import { APP_ERROR_CODES } from './errors.js';
import {
  HardwareDevice,
  HostHardware,
  HostHardwareOutput,
  hardwareProblems,
  hostText,
  hostTextSchema,
} from './hardware.js';
import {
  HostNetwork,
  HostNetworkOutput,
  HostWifiScanOutput,
  NETWORK_CHANGE_PHASES,
  NetworkAuditPayload,
  networkChangeDone,
  ssidValid,
  WIFI_ERROR_CODES,
  WIFI_ERROR_STATUS,
  WifiErrorDetails,
  wifiSignalFromDbm,
} from './network.js';
import { operationSafety, resendAfterNotFound } from './operation-safety.js';
import { createOperationAllowlist, SESSION_OPERATIONS } from './operations.js';
import { APPLIANCE_EVENT_TYPES, ApplianceEventType } from './providers.js';
import { decodeTolerant } from './tolerant.js';

const OPS = ['host.hardware', 'host.network', 'host.wifi.scan', 'host.wifi.join', 'host.wifi.forget'];
const READS = ['host.hardware', 'host.network', 'host.wifi.scan'];

const device = (patch: Partial<HardwareDevice>): HardwareDevice => ({
  kind: 'other',
  name: 'x',
  bus: 'pci',
  driver: 'x',
  status: 'ok',
  ...patch,
});
const hardware: HostHardware = {
  collectedAt: '2026-10-20T15:00:00Z',
  kernel: '6.18.53',
  machine: { vendor: 'ASUSTeK COMPUTER INC.', model: 'ROG Flow Z13 GZ302EA_GZ302EA', virtual: false },
  cpu: { model: 'AMD RYZEN AI MAX+ 395 w/ Radeon 8060S', cores: 16, threads: 32 },
  memoryBytes: 133_143_986_176,
  devices: [
    device({ kind: 'storage', name: 'NVMe disk', status: 'no_driver' }),
    device({ kind: 'bluetooth', name: 'MT7925 Bluetooth', status: 'no_firmware' }),
    device({ kind: 'sound', name: 'acp-pdm-mic', card: 'acppdmmach', capture: 1, playback: 0 }),
    device({ kind: 'graphics', name: 'Radeon 8060S', status: 'no_firmware' }),
    device({ kind: 'wifi', name: 'AX211', driver: null, status: 'no_driver' }),
    device({ kind: 'wired', name: 'RTL8153', status: 'disabled' }),
  ],
  log: ['amdgpu 0000:c3:00.0: Direct firmware load for amdgpu/gc_11_5_1_mes_2.bin failed with error -2'],
};
const network: HostNetwork = {
  online: true,
  checkedAt: '2026-10-20T14:59:40Z',
  wired: [{ interface: 'enx00e04c680001', connected: true, address: '10.100.1.42' }],
  wifi: { interface: 'wlp194s0', state: 'disconnected', saved: [] },
  change: null,
};

describe('the box’s hardware and network over the session (CT-568, CT-572)', () => {
  it('has five session-native app ops; the join is secret', () => {
    const allow = createOperationAllowlist();
    for (const op of OPS) {
      const spec = SESSION_OPERATIONS.get(op);
      expect(spec?.source, op).toBe('session');
      expect(spec?.channel, op).toBe('app');
      expect(allow.resolve(op, { enrolled: false }), op).toEqual({ ok: false, code: 'enrollment_required' });
      expect(spec?.secret, op).toBe(op === 'host.wifi.join');
      expect(spec?.mutating, op).toBe(!READS.includes(op));
      expect(spec?.ephemeral, op).toBe(false);
    }
  });

  it('never resends a join or a forget by itself', () => {
    for (const op of READS) expect(operationSafety(op), op).toEqual({ destructive: false, retry: 'safe' });
    for (const op of ['host.wifi.join', 'host.wifi.forget']) {
      expect(operationSafety(op), op).toEqual({ destructive: false, retry: 'never' });
      expect(resendAfterNotFound(op), op).toBe(false);
    }
  });

  it('takes a name, a passphrase and hidden, strictly', () => {
    const join = SESSION_OPERATIONS.get('host.wifi.join')?.input;
    expect(join?.safeParse({ ssid: 'Home', passphrase: 'correct horse battery' }).success).toBe(true);
    expect(join?.safeParse({ ssid: 'Attic', hidden: true }).success).toBe(true);
    expect(join?.safeParse({ ssid: 'Home', passphrase: 'ab'.repeat(32) }).success).toBe(true);
    expect(join?.safeParse({ ssid: 'Home', passphrase: 'short' }).success).toBe(false);
    expect(join?.safeParse({ ssid: 'Home', passphrase: 'x'.repeat(64) }).success).toBe(false);
    expect(join?.safeParse({ ssid: 'Home', security: 'psk' }).success).toBe(false);
    // 32 code points of two bytes each: the pattern takes it, the 32-byte limit doesn't.
    expect(join?.safeParse({ ssid: 'ä'.repeat(32) }).success).toBe(false);
    expect(join?.safeParse({ ssid: 'ä'.repeat(16) }).success).toBe(true);
    const forget = SESSION_OPERATIONS.get('host.wifi.forget')?.input;
    expect(forget?.safeParse({ ssid: 'Office' }).success).toBe(true);
    expect(forget?.safeParse({ ssid: 'Office', passphrase: 'correct horse battery' }).success).toBe(false);
    for (const op of READS) expect(SESSION_OPERATIONS.get(op)?.input.safeParse({}).success, op).toBe(true);
  });

  it('answers null with a reason where there is nothing to read', () => {
    expect(HostHardwareOutput.parse({ hardware: null, reason: 'not_managed' }).reason).toBe('not_managed');
    expect(HostHardwareOutput.parse({ hardware }).hardware?.kernel).toBe('6.18.53');
    expect(HostNetworkOutput.parse({ network, reason: undefined }).network?.online).toBe(true);
    expect(HostWifiScanOutput.parse({ scan: null, reason: 'no_wifi' }).reason).toBe('no_wifi');
    expect(HostWifiScanOutput.safeParse({ scan: null, reason: 'offline' }).success).toBe(false);
  });

  it('refuses with codes that have a description and a status', () => {
    for (const code of WIFI_ERROR_CODES) {
      expect(APP_ERROR_CODES, code).toHaveProperty(code);
      expect(WIFI_ERROR_STATUS[code], code).toBeTruthy();
    }
    expect(WIFI_ERROR_STATUS.in_use).toBe('conflict');
    expect(WifiErrorDetails.parse({ code: 'not_saved' })).toEqual({ code: 'not_saved' });
  });

  it('lets an older app read a newer kind or state without failing the answer', () => {
    const r = decodeTolerant(HostHardware, {
      ...hardware,
      devices: [...hardware.devices, device({ kind: 'printer' as never })],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.devices).toHaveLength(hardware.devices.length);
    const n = decodeTolerant(HostNetwork, { ...network, wifiMissing: 'unplugged' });
    expect(n.ok).toBe(true);
    if (n.ok) expect(n.data.wifiMissing).toBeUndefined();
  });
});

describe('the hardware report (CT-560…CT-562)', () => {
  it('lists Wi-Fi, wired, sound and graphics problems first, the rest after, in report order', () => {
    expect(hardwareProblems(hardware)).toEqual([
      { kind: 'wifi', name: 'AX211', status: 'no_driver' },
      { kind: 'wired', name: 'RTL8153', status: 'disabled' },
      { kind: 'graphics', name: 'Radeon 8060S', status: 'no_firmware' },
      { kind: 'storage', name: 'NVMe disk', status: 'no_driver' },
      { kind: 'bluetooth', name: 'MT7925 Bluetooth', status: 'no_firmware' },
    ]);
    expect(hardwareProblems({ devices: [device({})] })).toEqual([]);
  });

  it('cleans display text into one line that fits', () => {
    expect(hostText('  Realtek\tRTL8153\n Gigabit  ', 120)).toBe('Realtek RTL8153 Gigabit');
    expect(hostText('pve\u200b-02', 64)).toBe('pve-02');
    expect([...hostText('ä'.repeat(200), 120)]).toHaveLength(120);
    expect(hostText('ä'.repeat(200), 120).endsWith('…')).toBe(true);
    expect(hostTextSchema(120).safeParse(hostText(`a\u202eb${'x'.repeat(300)}`, 120)).success).toBe(true);
  });

  it('carries no serial number or MAC address', () => {
    const machine = { ...hardware.machine, serial: 'R9NRKD00123456A' };
    expect(HostHardware.parse({ ...hardware, machine }).machine).not.toHaveProperty('serial');
    const mac = { ...hardware.devices[0], mac: '00:11:22:33:44:55' };
    expect(HardwareDevice.parse(mac)).not.toHaveProperty('mac');
  });
});

describe('Wi-Fi (CT-564…CT-567)', () => {
  it('counts a name’s bytes', () => {
    expect(ssidValid('Home')).toBe(true);
    expect(ssidValid('🎉'.repeat(8))).toBe(true);
    expect(ssidValid('🎉'.repeat(9))).toBe(false);
    expect(ssidValid('Home\nOffice')).toBe(false);
  });

  it('gives bars for a strength', () => {
    expect([-50, -60, -70, -80, -90].map(wifiSignalFromDbm)).toEqual([4, 3, 2, 1, 0]);
  });

  it('knows when a change is over', () => {
    expect(NETWORK_CHANGE_PHASES.filter(networkChangeDone)).toEqual(['committed', 'reverted', 'failed']);
  });
});

describe('Wi-Fi in the audit log (CT-571)', () => {
  it('records joins and forgets by name, where they came from and the change', () => {
    expect(APPLIANCE_EVENT_TYPES).toContain('network.wifi_joined');
    expect(ApplianceEventType.parse('network.wifi_forgotten')).toBe('network.wifi_forgotten');
    const p = { ssid: 'Home', via: 'screen', changeId: 'c-k3q9xv2m' };
    expect(NetworkAuditPayload.parse(p)).toEqual(p);
    expect(NetworkAuditPayload.safeParse({ ...p, via: 'console' }).success).toBe(false);
    expect(NetworkAuditPayload.safeParse({ ...p, changeId: 'k3q9xv2m' }).success).toBe(false);
  });

  it('never keeps a passphrase: parsing before writing strips it', () => {
    const parsed = NetworkAuditPayload.parse({
      ssid: 'Home',
      via: 'app',
      changeId: 'c-k3q9xv2m',
      passphrase: 'correct horse battery',
    });
    expect(parsed).not.toHaveProperty('passphrase');
    expect(JSON.stringify(parsed)).not.toContain('horse');
  });
});
