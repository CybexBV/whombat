/**
 * The machine without a box (Whombat hardware-support.md HD-03, HD-05, HD-06; app hardware-support-web.md AP-3221): a
 * hardware report and a network as the manager and runtime answer them, in memory, for the web's fixture mode and
 * managed fake world, the phone's demo world and tests. Three machines (HD-01: any machine, not one laptop):
 *
 * - `z13`: a ROG Flow Z13-like laptop — MediaTek MT7925 Wi-Fi on `mt7925e`, AMD HD-Audio cards and the ACP microphone
 *   card of its own, Radeon 8060S graphics, an NVMe disk, a battery and a USB Ethernet adapter on `r8152`; on the
 *   cable and on “Home” Wi-Fi.
 * - `vm`: a QEMU/KVM virtual machine with virtio devices and a cable, no Wi-Fi card.
 * - `nodriver`: a small PC whose Intel Wi-Fi card has no driver (and its Bluetooth is switched off), on a cable.
 *
 * The networks nearby: Home (saved, in use), Neighbours, Café Wombat (open, no internet: a join goes back), Lumio Corp
 * (company network), Old Router (WEP) and Attic (hidden; joined with Other network…). Joins run `applying →
 * confirming → committed` (or back) on an injectable clock; a wrong password fails at once and keeps nothing.
 * `host.cable.set` (Whombat network-move.md; app network-move-app.md) switches the cable off (Wi-Fi only) or
 * on again, guarded the same way (Wi-Fi only on Café Wombat goes back), and starts the servers' move: six servers
 * find the box's new address one by one (`moveMissing` of them never do).
 *
 * Bluetooth's fake (the paired devices, a scan and its pairings) is `bluetooth-fake.ts`, exported from here too.
 */
import { OperationError } from '../session/managed-ops';
import type {
  CableChange,
  CableErrorCode,
  CableUse,
  HardwareDevice,
  HostHardware,
  HostNetwork,
  NetworkChange,
  NetworkChangeFailure,
  ServerMove,
  WifiErrorCode,
  WifiNetwork,
  WifiScan,
  WifiSecurity,
} from './contract';
import { CABLE_ERROR_STATUS, WIFI_ERROR_STATUS } from './contract';
import type { NetworkApi } from './network';

export * from './bluetooth-fake';

export type FakeMachine = 'z13' | 'vm' | 'nodriver';
export const FAKE_MACHINES: readonly FakeMachine[] = ['z13', 'vm', 'nodriver'];

const GB = 1_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/* Hardware ------------------------------------------------------------------------------------------------------- */

const Z13_DEVICES: HardwareDevice[] = [
  {
    kind: 'wifi',
    name: 'MT7925 Wi-Fi 7',
    vendor: 'MediaTek',
    bus: 'pci',
    id: '14c3:7925',
    driver: 'mt7925e',
    status: 'ok',
    interface: 'wlan0',
    link: 'up',
  },
  {
    kind: 'wired',
    name: 'RTL8153 Gigabit Ethernet Adapter',
    vendor: 'Realtek',
    bus: 'usb',
    id: '0bda:8153',
    driver: 'r8152',
    status: 'ok',
    interface: 'enp0s13f0u1',
    link: 'up',
    speedMbps: 1000,
  },
  {
    kind: 'bluetooth',
    name: 'MT7925 Bluetooth',
    vendor: 'MediaTek',
    bus: 'usb',
    id: '0489:e0e2',
    driver: 'btusb',
    status: 'ok',
  },
  {
    kind: 'sound',
    name: 'HD-Audio Generic',
    vendor: 'AMD',
    bus: 'pci',
    id: '1022:15e3',
    driver: 'snd_hda_intel',
    status: 'ok',
    card: 'Generic_1',
    playback: 1,
    capture: 0,
  },
  {
    kind: 'sound',
    name: 'Radeon High Definition Audio',
    vendor: 'AMD',
    bus: 'pci',
    id: '1002:1640',
    driver: 'snd_hda_intel',
    status: 'ok',
    card: 'Generic',
    playback: 4,
    capture: 0,
  },
  {
    kind: 'sound',
    name: 'ACP digital microphone',
    vendor: 'AMD',
    bus: 'platform',
    driver: 'snd_acp_pci',
    status: 'ok',
    card: 'acppdmmach',
    playback: 0,
    capture: 1,
  },
  {
    kind: 'graphics',
    name: 'Radeon 8060S',
    vendor: 'AMD',
    bus: 'pci',
    id: '1002:1586',
    driver: 'amdgpu',
    status: 'ok',
  },
  {
    kind: 'display',
    name: 'Built-in screen (eDP-1)',
    bus: 'platform',
    driver: 'amdgpu',
    status: 'ok',
    connected: true,
  },
  {
    kind: 'display',
    name: 'USB-C screen (DP-1)',
    bus: 'platform',
    driver: 'amdgpu',
    status: 'ok',
    connected: false,
  },
  {
    kind: 'storage',
    name: 'PM9C1a NVMe 1 TB',
    vendor: 'Samsung',
    bus: 'pci',
    id: '144d:a80d',
    driver: 'nvme',
    status: 'ok',
    sizeBytes: 1_024_209_543_168,
  },
  { kind: 'battery', name: 'Battery', vendor: 'ASUSTeK', bus: 'platform', driver: 'battery', status: 'ok' },
  {
    kind: 'camera',
    name: 'USB2.0 FHD UVC WebCam',
    vendor: 'Sonix',
    bus: 'usb',
    id: '3277:0059',
    driver: 'uvcvideo',
    status: 'ok',
  },
  {
    kind: 'input',
    name: 'ELAN9008 touchscreen',
    vendor: 'ELAN',
    bus: 'platform',
    driver: 'hid_multitouch',
    status: 'ok',
  },
];

const VM_DEVICES: HardwareDevice[] = [
  {
    kind: 'wired',
    name: 'Virtio network device',
    vendor: 'Red Hat',
    bus: 'pci',
    id: '1af4:1041',
    driver: 'virtio_net',
    status: 'ok',
    interface: 'enp5s0',
    link: 'up',
    speedMbps: 10_000,
  },
  {
    kind: 'graphics',
    name: 'Virtio GPU',
    vendor: 'Red Hat',
    bus: 'pci',
    id: '1af4:1050',
    driver: 'virtio_gpu',
    status: 'ok',
  },
  {
    kind: 'storage',
    name: 'Virtio block device',
    vendor: 'Red Hat',
    bus: 'pci',
    id: '1af4:1042',
    driver: 'virtio_blk',
    status: 'ok',
    sizeBytes: 107_374_182_400,
  },
  {
    kind: 'usb',
    name: 'QEMU USB Tablet',
    vendor: 'QEMU',
    bus: 'usb',
    id: '0627:0001',
    driver: 'usbhid',
    status: 'ok',
  },
];

const NODRIVER_DEVICES: HardwareDevice[] = [
  {
    kind: 'wifi',
    name: 'Wi-Fi 7 BE200',
    vendor: 'Intel',
    bus: 'pci',
    id: '8086:272b',
    driver: null,
    status: 'no_driver',
  },
  {
    kind: 'bluetooth',
    name: 'BE200 Bluetooth',
    vendor: 'Intel',
    bus: 'usb',
    id: '8087:0036',
    driver: 'btusb',
    status: 'disabled',
  },
  {
    kind: 'wired',
    name: 'Ethernet Controller I226-V',
    vendor: 'Intel',
    bus: 'pci',
    id: '8086:125c',
    driver: 'igc',
    status: 'ok',
    interface: 'enp2s0',
    link: 'up',
    speedMbps: 2500,
  },
  {
    kind: 'sound',
    name: 'Meteor Lake-P HD Audio',
    vendor: 'Intel',
    bus: 'pci',
    id: '8086:7e28',
    driver: 'snd_hda_intel',
    status: 'ok',
    card: 'PCH',
    playback: 2,
    capture: 1,
  },
  {
    kind: 'graphics',
    name: 'Arc Graphics',
    vendor: 'Intel',
    bus: 'pci',
    id: '8086:7d55',
    driver: 'i915',
    status: 'ok',
  },
  { kind: 'display', name: 'HDMI-A-1', bus: 'platform', driver: 'i915', status: 'ok', connected: true },
  {
    kind: 'storage',
    name: 'WD Blue SN580 500 GB',
    vendor: 'Western Digital',
    bus: 'pci',
    id: '15b7:5041',
    driver: 'nvme',
    status: 'ok',
    sizeBytes: 500_107_862_016,
  },
];

/** The hardware report of a machine, collected at `now`. */
export function fakeHardware(machine: FakeMachine, now: number = Date.now()): HostHardware {
  const collectedAt = iso(now);
  if (machine === 'vm')
    return {
      collectedAt,
      kernel: '6.18.53',
      machine: { vendor: 'QEMU', model: 'Standard PC (Q35 + ICH9, 2009)', virtual: true, hypervisor: 'KVM' },
      cpu: { model: 'AMD EPYC-Milan Processor', cores: 4, threads: 4 },
      memoryBytes: 16 * GB,
      devices: VM_DEVICES,
      log: [],
    };
  if (machine === 'nodriver')
    return {
      collectedAt,
      kernel: '6.18.53',
      machine: { vendor: 'Minisforum', model: 'MS-A1', family: 'Venus', firmware: '1.04', virtual: false },
      cpu: { model: 'Intel Core Ultra 5 125H', cores: 14, threads: 18 },
      memoryBytes: 32 * GB,
      devices: NODRIVER_DEVICES,
      log: [
        '[    4.112233] pci 0000:03:00.0: [8086:272b] no driver bound',
        '[    5.901020] rfkill: hci0 soft blocked',
      ],
    };
  return {
    collectedAt,
    kernel: '6.18.53',
    machine: {
      vendor: 'ASUSTeK COMPUTER INC.',
      model: 'ROG Flow Z13 GZ302EA',
      family: 'ROG Flow Z13',
      firmware: 'GZ302EA.308',
      virtual: false,
    },
    cpu: { model: 'AMD Ryzen AI Max+ 395 w/ Radeon 8060S', cores: 16, threads: 32 },
    memoryBytes: 32 * GB,
    devices: Z13_DEVICES,
    log: ['[    3.402118] amdgpu 0000:c4:00.0: amdgpu: SMU driver if version not matched'],
  };
}

/* Network -------------------------------------------------------------------------------------------------------- */

/** A network nearby: what a scan shows, and what the fake knows about it. */
interface Nearby {
  ssid: string;
  security: WifiSecurity;
  signal: 0 | 1 | 2 | 3 | 4;
  /** Psk networks: the right password. */
  password?: string;
  /** Hidden: not in a scan, joined by name. */
  hidden?: boolean;
  /** Joined, the box can't reach Whombat through it (a captive café network). */
  noInternet?: boolean;
}

/** The networks around the fixture machines. */
export const FAKE_WIFI_NEARBY: readonly Nearby[] = [
  { ssid: 'Home', security: 'psk', signal: 4, password: 'wombat-burrow-42' },
  { ssid: 'Neighbours', security: 'psk', signal: 2, password: 'correct horse battery' },
  { ssid: 'Café Wombat', security: 'open', signal: 1, noInternet: true },
  { ssid: 'Lumio Corp', security: 'enterprise', signal: 3 },
  { ssid: 'Old Router', security: 'other', signal: 1 },
  { ssid: 'Attic', security: 'psk', signal: 3, password: 'attic-pass-1', hidden: true },
];

/** The right password of each psk network nearby (tests and the e2e journeys type them). */
export const FAKE_WIFI_PASSWORDS: Readonly<Record<string, string>> = Object.fromEntries(
  FAKE_WIFI_NEARBY.filter((n) => n.password).map((n) => [n.ssid, n.password as string]),
);

/** What survives a reload. */
export interface FakeNetworkSnapshot {
  machine: FakeMachine;
  cable: boolean;
  /** The Wi-Fi network in use, or null. */
  connected: string | null;
  saved: { ssid: string; security: WifiSecurity }[];
  /** The cable switched off by choice (absent: no). */
  wifiOnly?: boolean;
}

export interface FakeNetworkOptions {
  machine?: FakeMachine;
  now?: () => number;
  initial?: FakeNetworkSnapshot | null;
  /** How long joining and checking take (ms). */
  applyMs?: number;
  confirmMs?: number;
  /** The guard's time to undo a change (HD-06: 2 minutes). */
  guardMs?: number;
  /** The servers that follow the box's address after a cable change, one every `moveStepMs` (0: all at once). */
  moveTotal?: number;
  moveStepMs?: number;
  /** Of those, how many never find it (Point them here). */
  moveMissing?: number;
}

export interface FakeNetwork {
  /** One `host.network`, `host.wifi.*` or `host.cable.set` op as the runtime answers it. */
  call(op: string, input: unknown): { status: number; body: unknown };
  /** The cable plugged in or out (the guard then depends on the Wi-Fi). */
  plugCable(plugged: boolean): void;
  snapshot(): FakeNetworkSnapshot;
  onChange(listener: () => void): () => void;
}

/** The machine's network as it starts. */
export function fakeNetworkSeed(machine: FakeMachine): FakeNetworkSnapshot {
  return machine === 'z13'
    ? {
        machine,
        cable: true,
        connected: 'Home',
        saved: [
          { ssid: 'Home', security: 'psk' },
          { ssid: 'Office', security: 'psk' },
        ],
      }
    : { machine, cable: true, connected: null, saved: [] };
}

const WIRED: Record<FakeMachine, { interface: string; address: string; mac: string }> = {
  z13: { interface: 'enp0s13f0u1', address: '192.168.1.42', mac: '02:00:00:68:0a:1f' },
  vm: { interface: 'enp5s0', address: '10.100.1.20', mac: '52:54:00:3c:9e:11' },
  nodriver: { interface: 'enp2s0', address: '192.168.1.60', mac: '00:1b:21:8a:44:07' },
};
/** The Z13's Wi-Fi card: its address on any network nearby (one subnet with the cable) and its hardware address. */
const WIFI_CARD = { address: '192.168.1.43', mac: 'ae:00:00:16:47:58' };

const ok = (body: unknown) => ({ status: 200, body });
const accepted = (body: unknown) => ({ status: 202, body });
const err = (status: number, code: string, message: string, details?: unknown) => ({
  status,
  body: { error: { code, message, ...(details ? { details } : {}) } },
});
/** A Wi-Fi refusal as the runtime sends it: the generic code and its status, the Wi-Fi code in `details` (CT-569). */
const STATUS: Record<string, number> = {
  not_allowed: 403,
  conflict: 409,
  not_found: 404,
  validation_failed: 400,
};
const refuse = (code: WifiErrorCode, message: string) => {
  const generic = WIFI_ERROR_STATUS[code];
  return err(STATUS[generic] ?? 400, generic, message, { code });
};
/** A cable refusal as the runtime sends it. */
const refuseCable = (code: CableErrorCode, message: string) => {
  const generic = CABLE_ERROR_STATUS[code];
  return err(STATUS[generic] ?? 400, generic, message, { code });
};

/** A change and where it goes (the fake's own plan, unknown to the app). */
interface Running {
  change: NetworkChange;
  startedAt: number;
  /** What it ends as. */
  outcome: { phase: 'committed' } | { phase: 'failed' | 'reverted'; failure: NetworkChangeFailure };
  /** The guard confirms (the box was online before). */
  confirm: boolean;
  before: FakeNetworkSnapshot;
}

/** A cable change and where it goes. */
interface CableRunning {
  change: CableChange;
  startedAt: number;
  outcome: { phase: 'committed' } | { phase: 'reverted'; failure: NetworkChangeFailure };
  before: FakeNetworkSnapshot;
}

export function createFakeNetwork(options: FakeNetworkOptions = {}): FakeNetwork {
  const now = options.now ?? Date.now;
  const applyMs = options.applyMs ?? 1_500;
  const confirmMs = options.confirmMs ?? 3_000;
  const guardMs = options.guardMs ?? 120_000;
  let snap: FakeNetworkSnapshot = options.initial ?? fakeNetworkSeed(options.machine ?? 'z13');
  let running: Running | null = null;
  let cableRunning: CableRunning | null = null;
  /** The servers following the box: from where to where, since when. */
  let move: { from: string; to: string; since: number } | null = null;
  const moveTotal = options.moveTotal ?? 6;
  const moveStepMs = options.moveStepMs ?? 2_500;
  const moveMissing = options.moveMissing ?? 0;
  let changes = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of [...listeners]) l();
  };
  const hasWifi = () => snap.machine === 'z13';
  const nearby = (ssid: string) => FAKE_WIFI_NEARBY.find((n) => n.ssid === ssid);
  /** A cable plugged in and not switched off. */
  const cableUp = (s: FakeNetworkSnapshot) => s.cable && !s.wifiOnly;
  /** The box reaches Whombat: a cable, or a Wi-Fi network with internet. */
  const online = (s: FakeNetworkSnapshot) =>
    cableUp(s) ||
    (s.connected !== null && !nearby(s.connected)?.noInternet && nearby(s.connected) !== undefined);

  /** Moves the running change along by the clock (pure in time, so a reload in between changes nothing). */
  function advance() {
    const r = running;
    if (!r) return;
    const t = now() - r.startedAt;
    const final = r.outcome.phase;
    let phase: NetworkChange['phase'];
    if (t < applyMs) phase = 'applying';
    else if (final === 'failed') phase = 'failed';
    else if (!r.confirm) phase = final === 'committed' ? 'committed' : 'reverted';
    else if (t < applyMs + confirmMs) phase = 'confirming';
    else if (final === 'committed') phase = 'committed';
    else if (t < applyMs + 2 * confirmMs) phase = 'reverting';
    else phase = 'reverted';
    if (phase === r.change.phase) return;
    // `failure` exactly in reverting, reverted and failed (CT-567).
    const failure =
      phase === 'failed' || phase === 'reverting' || phase === 'reverted'
        ? (r.outcome as { failure: NetworkChangeFailure }).failure
        : undefined;
    r.change = { ...r.change, phase, ...(failure ? { failure } : {}) };
    const ssid = r.change.ssid;
    if (phase === 'failed' || phase === 'reverted')
      snap = { ...r.before, cable: snap.cable, wifiOnly: snap.wifiOnly };
    else if (r.change.kind === 'join') {
      // Joined while it is checked (and while it goes back); kept once it worked.
      if (phase !== 'applying') snap = { ...snap, connected: ssid };
      if (phase === 'committed') snap = { ...snap, saved: saveOnce(snap.saved, ssid) };
    } else if (phase === 'committed')
      snap = {
        ...snap,
        saved: snap.saved.filter((s) => s.ssid !== ssid),
        connected: snap.connected === ssid ? null : snap.connected,
      };
    changed();
  }

  /** Moves the cable change along: switched while it is checked (and while it goes back), as it was once undone. */
  function advanceCable() {
    const r = cableRunning;
    if (!r) return;
    const t = now() - r.startedAt;
    let phase: CableChange['phase'];
    if (t < applyMs) phase = 'applying';
    else if (t < applyMs + confirmMs) phase = 'confirming';
    else if (r.outcome.phase === 'committed') phase = 'committed';
    else if (t < applyMs + 2 * confirmMs) phase = 'reverting';
    else phase = 'reverted';
    if (phase === r.change.phase) return;
    const failure =
      phase === 'reverting' || phase === 'reverted'
        ? (r.outcome as { failure: NetworkChangeFailure }).failure
        : undefined;
    r.change = { ...r.change, phase, ...(failure ? { failure } : {}) };
    if (phase === 'confirming' || phase === 'committed' || phase === 'reverting')
      snap = { ...snap, wifiOnly: r.change.use === 'wifi' };
    if (phase === 'reverted') {
      snap = { ...snap, wifiOnly: r.before.wifiOnly };
      move = null;
    }
    changed();
  }

  /** The servers' move as `host.network` tells it: one more finds the box every `moveStepMs`. */
  function moveNow(): ServerMove | undefined {
    if (!move) return undefined;
    const reachable = Math.max(0, moveTotal - moveMissing);
    const found =
      moveStepMs > 0 ? Math.min(reachable, Math.floor((now() - move.since) / moveStepMs)) : reachable;
    return { from: move.from, to: move.to, since: iso(move.since), total: moveTotal, found };
  }

  const saveOnce = (saved: FakeNetworkSnapshot['saved'], ssid: string) =>
    saved.some((s) => s.ssid === ssid)
      ? saved
      : [...saved, { ssid, security: nearby(ssid)?.security ?? 'psk' }];

  function network(): HostNetwork {
    advance();
    advanceCable();
    const wired = WIRED[snap.machine];
    const connected = snap.connected ? nearby(snap.connected) : undefined;
    const change = running?.change ?? null;
    const card = { interface: wired.interface, mac: wired.mac };
    return {
      online: online(snap),
      checkedAt: iso(now() - 20_000),
      // A switched-off cable stays listed (its link up, no address); unplugged, the adapter's interface stays too.
      wired: cableUp(snap)
        ? [{ ...card, connected: true, address: wired.address, prefixLength: 24, plugged: true }]
        : snap.wifiOnly
          ? [{ ...card, connected: false, plugged: snap.cable }]
          : [],
      wifi: hasWifi()
        ? {
            interface: 'wlan0',
            state:
              change?.kind === 'join' && change.phase === 'applying'
                ? 'connecting'
                : snap.connected
                  ? 'connected'
                  : 'disconnected',
            ...(change?.kind === 'join' && change.phase === 'applying'
              ? { ssid: change.ssid }
              : connected
                ? {
                    ssid: connected.ssid,
                    signal: connected.signal,
                    address: WIFI_CARD.address,
                    prefixLength: 24,
                  }
                : {}),
            saved: snap.saved,
            mac: WIFI_CARD.mac,
          }
        : null,
      ...(hasWifi()
        ? {}
        : { wifiMissing: snap.machine === 'vm' ? ('no_adapter' as const) : ('no_driver' as const) }),
      change,
      wifiOnly: snap.wifiOnly === true,
      ...(cableRunning ? { cableChange: cableRunning.change } : {}),
    };
  }

  function scan(): WifiScan {
    advance();
    const networks: WifiNetwork[] = FAKE_WIFI_NEARBY.filter((n) => !n.hidden)
      .map((n) => ({
        ssid: n.ssid,
        security: n.security,
        signal: n.signal,
        saved: snap.saved.some((s) => s.ssid === n.ssid),
        connected: snap.connected === n.ssid,
      }))
      .sort((a, b) => b.signal - a.signal);
    return { networks, scannedAt: iso(now()) };
  }

  const busy = () => {
    advance();
    advanceCable();
    const runs = (phase: string) => ['applying', 'confirming', 'reverting'].includes(phase);
    return (
      (running !== null && runs(running.change.phase)) ||
      (cableRunning !== null && runs(cableRunning.change.phase))
    );
  };

  function startCable(use: CableUse, outcome: CableRunning['outcome']): CableChange {
    changes += 1;
    const change: CableChange = {
      id: `c-${String(changes).padStart(8, '0')}`,
      use,
      by: 'person',
      phase: 'applying',
      deadline: iso(now() + guardMs),
    };
    cableRunning = { change, startedAt: now(), outcome, before: { ...snap } };
    // The servers are asked to move before the cable goes.
    const wired = WIRED[snap.machine];
    move =
      use === 'wifi'
        ? { from: wired.address, to: WIFI_CARD.address, since: now() }
        : { from: WIFI_CARD.address, to: wired.address, since: now() };
    changed();
    return change;
  }

  function start(kind: 'join' | 'forget', ssid: string, outcome: Running['outcome']): NetworkChange {
    changes += 1;
    const before = { ...snap };
    const change: NetworkChange = {
      id: `c-${String(changes).padStart(8, '0')}`,
      kind,
      ssid,
      phase: 'applying',
      deadline: iso(now() + guardMs),
      ...(snap.connected ? { previous: snap.connected } : {}),
    };
    running = { change, startedAt: now(), outcome, confirm: online(snap), before };
    changed();
    return change;
  }

  return {
    call(op, raw) {
      const input = (raw ?? {}) as { ssid?: string; passphrase?: string; hidden?: boolean };
      switch (op) {
        case 'host.network': {
          const n = network();
          const m = moveNow();
          return ok({ network: n, ...(m ? { move: m } : {}) });
        }
        case 'host.cable.set': {
          const use = (raw as { use?: unknown } | null)?.use;
          if (use !== 'wifi' && use !== 'cable') return err(400, 'validation_failed', 'use is wifi or cable');
          if (busy()) return refuseCable('busy', 'A network change is running.');
          if (use === 'wifi') {
            if (!hasWifi()) return refuseCable('no_wifi', 'This Whombat has no Wi-Fi.');
            if (snap.wifiOnly) return refuseCable('unchanged', 'Already Wi-Fi only.');
            if (!snap.connected) return refuseCable('not_connected', 'The Wi-Fi is not on a network.');
            // A network without internet: the guard brings the cable back.
            const back = nearby(snap.connected)?.noInternet === true;
            return accepted({
              change: startCable(
                'wifi',
                back ? { phase: 'reverted', failure: 'no_internet' } : { phase: 'committed' },
              ),
            });
          }
          if (!snap.wifiOnly) return refuseCable('unchanged', 'Already on the cable.');
          if (!snap.cable) return refuseCable('no_cable', 'No cable is plugged in.');
          return accepted({ change: startCable('cable', { phase: 'committed' }) });
        }
        case 'host.wifi.scan':
          return hasWifi() ? ok({ scan: scan() }) : ok({ scan: null, reason: 'no_wifi' });
        case 'host.wifi.join': {
          if (!hasWifi()) return refuse('no_wifi', 'This Whombat has no Wi-Fi.');
          if (busy()) return refuse('busy', 'A network change is running.');
          const ssid = String(input.ssid ?? '');
          const n = nearby(ssid);
          const saved = snap.saved.some((s) => s.ssid === ssid);
          if (
            input.passphrase !== undefined &&
            !/^(?:[\x20-\x7e]{8,63}|[0-9A-Fa-f]{64})$/.test(input.passphrase)
          )
            return refuse('invalid_passphrase', 'Invalid passphrase.');
          if (!n || (n.hidden && !input.hidden))
            return accepted({ change: start('join', ssid, { phase: 'failed', failure: 'not_found' }) });
          if (n.security === 'enterprise' || n.security === 'other')
            return accepted({ change: start('join', ssid, { phase: 'failed', failure: 'failed' }) });
          if (
            n.security === 'psk' &&
            !(saved && input.passphrase === undefined) &&
            input.passphrase !== n.password
          )
            return accepted({ change: start('join', ssid, { phase: 'failed', failure: 'wrong_password' }) });
          // The cable carries the box whatever the Wi-Fi does; without it a network without internet goes back.
          const back = n.noInternet && !cableUp(snap) && online(snap);
          return accepted({
            change: start(
              'join',
              ssid,
              back ? { phase: 'reverted', failure: 'no_internet' } : { phase: 'committed' },
            ),
          });
        }
        case 'host.wifi.forget': {
          if (!hasWifi()) return refuse('no_wifi', 'This Whombat has no Wi-Fi.');
          if (busy()) return refuse('busy', 'A network change is running.');
          const ssid = String(input.ssid ?? '');
          if (!snap.saved.some((s) => s.ssid === ssid)) return refuse('not_saved', 'Not saved.');
          if (snap.connected === ssid && !cableUp(snap) && online(snap))
            return refuse('in_use', 'The only working connection.');
          return accepted({ change: start('forget', ssid, { phase: 'committed' }) });
        }
        default:
          return err(404, 'unknown_op', `No operation ${op}`);
      }
    },
    plugCable(plugged) {
      snap = { ...snap, cable: plugged };
      changed();
    },
    snapshot: () => ({ ...snap }),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A fake network as the app's `NetworkApi` (refusals thrown as the session would). */
export function fakeNetworkApi(fake: FakeNetwork): NetworkApi {
  const answer = async <T>(op: string, input: unknown): Promise<T> => {
    const r = fake.call(op, input);
    if (r.status >= 200 && r.status < 300) return r.body as T;
    const e = (r.body as { error: { code: string; message: string; details?: unknown } }).error;
    throw new OperationError(op, r.status, e.code, e.message, e.details);
  };
  return {
    state: () => answer('host.network', {}),
    scan: () => answer('host.wifi.scan', {}),
    join: async (input) => (await answer<{ change: NetworkChange }>('host.wifi.join', input)).change,
    forget: async (ssid) => (await answer<{ change: NetworkChange }>('host.wifi.forget', { ssid })).change,
    setCable: async (use) => (await answer<{ change: CableChange }>('host.cable.set', { use })).change,
  };
}

/* Tailscale (hermes-engine-app.md AP-5305) ---------------------------------------------------------------------- */

export { createFakeMail, type FakeMail } from './mail-fake';
export { createFakeTailscale, type FakeTailscale } from './tailscale-fake';
