/**
 * A fake box behind the manager's hardware and network routes (hardware-support-server.md HD-S08), for tests and the
 * managed dev world (`FakeManager.host`): a machine like an ASUS ROG Flow Z13 (MediaTek MT7925 Wi-Fi, AMD HD-Audio and
 * the ACP microphone card, Radeon 8060S graphics, an NVMe disk, a battery, a USB Ethernet adapter on `r8152`), a cable,
 * and Wi-Fi networks in reach — one hidden, one company network, one without internet. Joins and forgets run through
 * the guard's phases on the clock it is given (`applying → confirming → committed`, or `reverting → reverted`), so a test
 * steps time instead of waiting. Refusals are the manager's: `ManagerCallError` with its statuses and codes (409
 * `no_wifi`, `busy`, `in_use`; 404 `not_saved`; 400 `invalid_passphrase`). Passphrases are checked and never kept.
 *
 * Wi-Fi only and the cable again (network-move.md NM-01…NM-03) run through the same phases: the cable stays plugged in
 * but takes no address while Wi-Fi only is on; a change the box can't reach Whombat after is undone. `backupToCable`
 * stands for the box turning its cable back on by itself (NM-03).
 */
import { MANAGER_PATHS } from '@whombat/control-contracts/local';
import type {
  CableChange,
  CableUse,
  HostHardware,
  HostNetwork,
  NetworkChange,
  NetworkChangeFailure,
  WifiScan,
  WifiSecurity,
} from '@whombat/protocol/session';
import { ManagerCallError } from './ports';

export interface FakeWifi {
  ssid: string;
  security: WifiSecurity;
  /** Bars, 0…4. */
  signal: number;
  /** The right passphrase of a `psk` network. */
  passphrase?: string;
  /** Not in scans: found only by name (`hidden: true` in the join). */
  hidden?: boolean;
  /** Whether Whombat can be reached through it (default yes). */
  internet?: boolean;
  /** Whether its DHCP answers (default yes). */
  dhcp?: boolean;
}

/** How long a fake change takes in each phase. */
export interface FakeHostTimings {
  /** `applying` (connecting and getting an address). */
  applyMs: number;
  /** `confirming` (the guard's check that Whombat can be reached), and `reverting`. */
  confirmMs: number;
  /** How long an ended change stays in the state. */
  keepMs: number;
}

export const FAKE_HOST_TIMINGS: FakeHostTimings = { applyMs: 2_000, confirmMs: 3_000, keepMs: 60_000 };

/** The networks in reach of the fake box: Office is saved and in use. */
export function fakeWifiNetworks(): FakeWifi[] {
  return [
    { ssid: 'Home', security: 'psk', signal: 4, passphrase: 'correct-horse-42' },
    { ssid: 'Office', security: 'psk', signal: 2, passphrase: 'office-pass-1' },
    { ssid: 'Attic', security: 'psk', signal: 3, passphrase: 'attic-pass-7', hidden: true },
    { ssid: 'Café Lumen', security: 'open', signal: 1, internet: false },
    { ssid: 'Lumio Corp', security: 'enterprise', signal: 3 },
    { ssid: 'OldRouter', security: 'other', signal: 0 },
  ];
}

/** A report like the Flow Z13's (GZ302EA): no serial numbers, no MAC addresses. */
export function z13Hardware(collectedAt: string): HostHardware {
  return {
    collectedAt,
    kernel: '6.18.53',
    machine: {
      vendor: 'ASUSTeK COMPUTER INC.',
      model: 'ROG Flow Z13 GZ302EA_GZ302EA',
      family: 'ROG Flow Z13',
      firmware: 'GZ302EA.308',
      virtual: false,
    },
    cpu: { model: 'AMD RYZEN AI MAX+ 395 w/ Radeon 8060S', cores: 16, threads: 32 },
    memoryBytes: 32_768_000_000,
    devices: [
      {
        kind: 'wifi',
        name: 'MT7925 802.11be 160MHz 2x2 PCIe Wireless Network Adapter [Filogic 360]',
        vendor: 'MEDIATEK Corp.',
        bus: 'pci',
        id: '14c3:7925',
        driver: 'mt7925e',
        status: 'ok',
        interface: 'wlp194s0',
        link: 'up',
      },
      {
        kind: 'wired',
        name: 'RTL8153 Gigabit Ethernet Adapter',
        vendor: 'Realtek Semiconductor Corp.',
        bus: 'usb',
        id: '0bda:8153',
        driver: 'r8152',
        status: 'ok',
        interface: 'enp198s0f4u1',
        link: 'up',
        speedMbps: 1000,
      },
      {
        kind: 'bluetooth',
        name: 'Wireless_Device',
        vendor: 'MediaTek Inc.',
        bus: 'usb',
        id: '0489:e10b',
        driver: 'btusb',
        status: 'ok',
      },
      {
        kind: 'sound',
        name: 'Radeon High Definition Audio Controller',
        vendor: 'Advanced Micro Devices, Inc. [AMD/ATI]',
        bus: 'pci',
        id: '1002:1640',
        driver: 'snd_hda_intel',
        status: 'ok',
        card: 'Generic',
        capture: 0,
        playback: 4,
      },
      {
        kind: 'sound',
        name: 'Family 17h/19h/1ah HD Audio Controller',
        vendor: 'Advanced Micro Devices, Inc. [AMD]',
        bus: 'pci',
        id: '1022:15e3',
        driver: 'snd_hda_intel',
        status: 'ok',
        card: 'Generic_1',
        capture: 0,
        playback: 1,
      },
      {
        kind: 'sound',
        name: 'ACP/ACP3X/ACP6x/ACP63/ACP70 Audio Coprocessor',
        vendor: 'Advanced Micro Devices, Inc. [AMD]',
        bus: 'pci',
        id: '1022:15e2',
        driver: 'snd_pci_ps',
        status: 'ok',
        card: 'acppdmmach',
        capture: 1,
        playback: 0,
      },
      {
        kind: 'graphics',
        name: 'Strix Halo [Radeon Graphics / Radeon 8050S / 8060S Graphics]',
        vendor: 'Advanced Micro Devices, Inc. [AMD/ATI]',
        bus: 'pci',
        id: '1002:1586',
        driver: 'amdgpu',
        status: 'ok',
      },
      { kind: 'display', name: 'eDP-1', bus: 'platform', driver: 'amdgpu', status: 'ok', connected: true },
      {
        kind: 'storage',
        name: 'WD PC SN5000S SDEPNSJ-1T00-1002',
        vendor: 'Sandisk Corp',
        bus: 'pci',
        id: '15b7:5030',
        driver: 'nvme',
        status: 'ok',
        sizeBytes: 1_024_209_543_168,
      },
      { kind: 'battery', name: 'BAT0', vendor: 'ASUSTeK', bus: 'platform', driver: null, status: 'ok' },
      {
        kind: 'camera',
        name: 'USB2.0 FHD UVC WebCam',
        vendor: 'Azurewave',
        bus: 'usb',
        id: '13d3:5463',
        driver: 'uvcvideo',
        status: 'ok',
      },
      {
        kind: 'input',
        name: 'ELAN9008:00 04F3:2C82',
        vendor: 'ELAN',
        bus: 'platform',
        driver: 'hid_multitouch',
        status: 'ok',
      },
    ],
    log: [],
  };
}

interface Step {
  at: number;
  run: () => void;
}

interface RunningChange<V extends { phase: NetworkChange['phase'] } = NetworkChange> {
  view: V;
  steps: Step[];
  endedAt: number | null;
}

const ENDED: ReadonlySet<NetworkChange['phase']> = new Set(['committed', 'reverted', 'failed']);
const WIFI = 'wlp194s0';

export class FakeHost {
  /** A manager before 0.102: every route answers 404. */
  older = false;
  /** The machine's report (`collectedAt` is set when asked). */
  hardware: HostHardware = z13Hardware('2026-10-20T12:00:00.000Z');
  /** Whether Whombat's endpoint can be reached at all (control up, the internet there). */
  controlReachable = true;
  /**
   * The USB Ethernet adapter's cable: `plugged` (a link), `connected` (in use: a link and an address; never while Wi-Fi
   * only is on).
   */
  cable = {
    interface: 'enp198s0f4u1',
    plugged: true,
    connected: true,
    address: '10.100.1.42',
    prefixLength: 24,
    mac: '02:00:00:68:01:2a',
  };
  /** The Wi-Fi card's address while it is on a network with DHCP, and its hardware address. */
  wifiAddress = '192.168.1.57';
  wifiPrefixLength = 24;
  wifiMac = 'ae:00:00:16:47:58';
  /** The cable is switched off by choice (NM-01). */
  wifiOnly = false;
  /** What cable changes were asked. */
  readonly cableSets: { use: CableUse; confirmTimeoutSec: number }[] = [];
  /** Why there is no Wi-Fi (`no_adapter`, `no_driver`, `disabled`), or null when the card works. */
  wifiMissing: 'no_adapter' | 'no_driver' | 'disabled' | null = null;
  readonly networks: FakeWifi[] = fakeWifiNetworks();
  /** Saved networks (iwd's profiles): their names. */
  readonly saved = new Set<string>(['Office']);
  /** The network the Wi-Fi card is on. */
  connected: string | null = 'Office';
  /** What was asked, passphrases left out. */
  readonly joins: { ssid: string; hidden: boolean; passphrase: boolean; confirmTimeoutSec: number }[] = [];
  readonly forgets: string[] = [];
  #change: RunningChange | null = null;
  #cableChange: RunningChange<CableChange> | null = null;
  #ids = 0;

  constructor(
    private readonly now: () => number = Date.now,
    readonly timings: FakeHostTimings = FAKE_HOST_TIMINGS,
  ) {}

  /** Whether the box reaches Whombat now: through the cable, or a Wi-Fi network with internet (HD-10). */
  online(): boolean {
    if (!this.controlReachable) return false;
    if (this.cable.connected) return true;
    const wifi = this.connected ? this.#network(this.connected) : null;
    return !!wifi && wifi.internet !== false && wifi.dhcp !== false;
  }

  hostHardware(): { v: 1; hardware: HostHardware } {
    this.#route(MANAGER_PATHS.hostHardware);
    return { v: 1, hardware: { ...this.hardware, collectedAt: this.#iso(this.now()) } };
  }

  networkState(): { v: 1; network: HostNetwork } {
    this.#route(MANAGER_PATHS.networkState);
    this.#advance();
    const now = this.now();
    // While a join applies, the card is connecting to its network (`ssid` exactly while connecting or connected).
    const joining =
      this.#change?.view.kind === 'join' && this.#change.view.phase === 'applying'
        ? this.#change.view.ssid
        : null;
    const on = this.connected ? this.#network(this.connected) : null;
    return {
      v: 1,
      network: {
        online: this.online(),
        checkedAt: this.#iso(now),
        wired: [
          {
            interface: this.cable.interface,
            connected: this.cable.connected,
            ...(this.cable.connected
              ? { address: this.cable.address, prefixLength: this.cable.prefixLength }
              : {}),
            plugged: this.cable.plugged,
            mac: this.cable.mac,
          },
        ],
        wifi: this.wifiMissing
          ? null
          : {
              interface: WIFI,
              state: joining ? 'connecting' : on ? 'connected' : 'disconnected',
              ...(joining
                ? { ssid: joining }
                : on
                  ? {
                      ssid: on.ssid,
                      signal: on.signal,
                      ...(on.dhcp !== false
                        ? { address: this.wifiAddress, prefixLength: this.wifiPrefixLength }
                        : {}),
                    }
                  : {}),
              mac: this.wifiMac,
              saved: [...this.saved].map((ssid) => ({
                ssid,
                security: this.#network(ssid)?.security ?? 'psk',
              })),
            },
        ...(this.wifiMissing ? { wifiMissing: this.wifiMissing } : {}),
        change: this.#change ? { ...this.#change.view } : null,
        ...(this.wifiOnly ? { wifiOnly: true } : {}),
        ...(this.#cableChange ? { cableChange: { ...this.#cableChange.view } } : {}),
      },
    };
  }

  /**
   * `POST /v1/network/cable` (NM-01, NM-02): 202 with the change in `applying`. Wi-Fi only switches the cable off (it
   * stays plugged in); the cable again switches it on. Confirmed like a join when the box reached Whombat before.
   */
  cableSet(request: { use: CableUse; confirmTimeoutSec: number }): { v: 1; change: CableChange } {
    const path = MANAGER_PATHS.networkCable;
    this.#route(path);
    this.#notBusy(path);
    const refuse = (code: string) => {
      throw new ManagerCallError(path, 409, code, `manager: 409 ${code}`);
    };
    const wifiOn = this.connected ? this.#network(this.connected) : null;
    if (request.use === 'wifi') {
      if (this.wifiMissing) refuse('no_wifi');
      if (this.wifiOnly) refuse('unchanged');
      if (!wifiOn || wifiOn.dhcp === false) refuse('not_connected');
    } else {
      if (!this.wifiOnly) refuse('unchanged');
      if (!this.cable.plugged) refuse('no_cable');
    }
    this.cableSets.push({ use: request.use, confirmTimeoutSec: request.confirmTimeoutSec });
    const t0 = this.now();
    const wasOnline = this.online();
    const view: CableChange = {
      id: this.#nextId(),
      use: request.use,
      by: 'person',
      phase: 'applying',
      deadline: this.#iso(t0 + request.confirmTimeoutSec * 1000),
    };
    const change: RunningChange<CableChange> = { view, steps: [], endedAt: null };
    const end = (at: number, phase: CableChange['phase'], failure?: CableChange['failure']) => {
      view.phase = phase;
      if (failure) view.failure = failure;
      change.endedAt = at;
    };
    const set = (use: CableUse) => {
      this.wifiOnly = use === 'wifi';
      this.cable.connected = !this.wifiOnly && this.cable.plugged;
    };
    const applied = t0 + this.timings.applyMs;
    const confirmed = applied + this.timings.confirmMs;
    change.steps.push({
      at: applied,
      run: () => {
        set(request.use);
        if (!wasOnline) return end(applied, 'committed');
        view.phase = 'confirming';
        change.steps.push({
          at: confirmed,
          run: () => {
            if (this.online()) return end(confirmed, 'committed');
            view.phase = 'reverting';
            view.failure = 'no_internet';
            change.steps.push({
              at: confirmed + this.timings.confirmMs,
              run: () => {
                set(request.use === 'wifi' ? 'cable' : 'wifi');
                end(confirmed + this.timings.confirmMs, 'reverted', 'no_internet');
              },
            });
          },
        });
      },
    });
    this.#cableChange = change;
    return { v: 1, change: { ...view } };
  }

  /** The box turned its cable back on by itself: Wi-Fi only lost Whombat while a cable was plugged in (NM-03). */
  backupToCable(): CableChange {
    const at = this.now();
    this.wifiOnly = false;
    this.cable.connected = this.cable.plugged;
    const view: CableChange = {
      id: this.#nextId(),
      use: 'cable',
      by: 'backup',
      phase: 'committed',
      deadline: this.#iso(at),
    };
    this.#cableChange = { view, steps: [], endedAt: at };
    return { ...view };
  }

  wifiScan(): { v: 1; scan: WifiScan } {
    this.#route(MANAGER_PATHS.wifiScan);
    this.#wifi(MANAGER_PATHS.wifiScan);
    this.#advance();
    const networks = this.networks
      .filter((n) => !n.hidden)
      .sort((a, b) => b.signal - a.signal)
      .map((n) => ({
        ssid: n.ssid,
        security: n.security,
        signal: n.signal,
        saved: this.saved.has(n.ssid),
        connected: this.connected === n.ssid,
      }));
    return { v: 1, scan: { networks, scannedAt: this.#iso(this.now()) } };
  }

  /** `POST /v1/network/wifi/join` (§2.4): 202 with the change in `applying`. */
  wifiJoin(request: { ssid: string; passphrase?: string; hidden?: boolean; confirmTimeoutSec: number }): {
    v: 1;
    change: NetworkChange;
  } {
    const path = MANAGER_PATHS.wifiJoin;
    this.#route(path);
    this.#wifi(path);
    const target = this.#network(request.ssid);
    const found = target && (!target.hidden || request.hidden === true);
    // A passphrase for an open network, or none for a secured one the box doesn't know (CT-569).
    if (
      found &&
      ((target.security === 'open' && request.passphrase !== undefined) ||
        (target.security === 'psk' && request.passphrase === undefined && !this.saved.has(target.ssid)))
    )
      throw new ManagerCallError(path, 400, 'invalid_passphrase', 'manager: 400 invalid_passphrase');
    this.#notBusy(path);
    this.joins.push({
      ssid: request.ssid,
      hidden: request.hidden === true,
      passphrase: request.passphrase !== undefined,
      confirmTimeoutSec: request.confirmTimeoutSec,
    });
    const t0 = this.now();
    const previous = this.connected;
    const wasOnline = this.online();
    const view: NetworkChange = {
      id: this.#nextId(),
      kind: 'join',
      ssid: request.ssid,
      phase: 'applying',
      deadline: this.#iso(t0 + request.confirmTimeoutSec * 1000),
      ...(previous ? { previous } : {}),
    };
    const change: RunningChange = { view, steps: [], endedAt: null };
    const end = (at: number, phase: NetworkChange['phase'], failure?: NetworkChangeFailure) => {
      view.phase = phase;
      if (failure) view.failure = failure;
      change.endedAt = at;
    };
    const applied = t0 + this.timings.applyMs;
    const confirmed = applied + this.timings.confirmMs;
    change.steps.push({
      at: applied,
      run: () => {
        if (!found) return end(applied, 'failed', 'not_found');
        if (target.security === 'enterprise' || target.security === 'other')
          return end(applied, 'failed', 'failed');
        // A wrong password fails at once and keeps nothing (HD-06).
        if (
          target.security === 'psk' &&
          request.passphrase !== undefined &&
          request.passphrase !== target.passphrase
        )
          return end(applied, 'failed', 'wrong_password');
        if (target.dhcp === false) return end(applied, 'failed', 'no_address');
        this.connected = target.ssid;
        this.saved.add(target.ssid);
        // Confirmed only when the box reached Whombat before (MG-15): else whatever it joined is better than nothing.
        if (!wasOnline) return end(applied, 'committed');
        view.phase = 'confirming';
        change.steps.push({
          at: confirmed,
          run: () => {
            if (this.online()) return end(confirmed, 'committed');
            view.phase = 'reverting';
            view.failure = 'no_internet';
            change.steps.push({
              at: confirmed + this.timings.confirmMs,
              run: () => {
                this.saved.delete(target.ssid);
                this.connected = previous;
                end(confirmed + this.timings.confirmMs, 'reverted', 'no_internet');
              },
            });
          },
        });
      },
    });
    this.#change = change;
    return { v: 1, change: { ...view } };
  }

  /** `POST /v1/network/wifi/forget` (§2.4): 202 with the change in `applying`. */
  wifiForget(request: { ssid: string }): { v: 1; change: NetworkChange } {
    const path = MANAGER_PATHS.wifiForget;
    this.#route(path);
    this.#wifi(path);
    this.#notBusy(path);
    if (!this.saved.has(request.ssid))
      throw new ManagerCallError(path, 404, 'not_saved', 'manager: 404 not_saved');
    // The network the box depends on, while nothing else works (HD-06).
    if (this.connected === request.ssid && !this.cable.connected && this.online())
      throw new ManagerCallError(path, 409, 'in_use', 'manager: 409 in_use');
    this.forgets.push(request.ssid);
    const t0 = this.now();
    const view: NetworkChange = {
      id: this.#nextId(),
      kind: 'forget',
      ssid: request.ssid,
      phase: 'applying',
      deadline: this.#iso(t0 + 120_000),
    };
    const change: RunningChange = { view, steps: [], endedAt: null };
    const at = t0 + this.timings.applyMs;
    change.steps.push({
      at,
      run: () => {
        this.saved.delete(request.ssid);
        if (this.connected === request.ssid) this.connected = null;
        view.phase = 'committed';
        change.endedAt = at;
      },
    });
    this.#change = change;
    return { v: 1, change: { ...view } };
  }

  /** Runs every step whose time has come; an ended change leaves the state after `keepMs`. */
  #advance(): void {
    if (this.#change && this.#stepped(this.#change)) this.#change = null;
    if (this.#cableChange && this.#stepped(this.#cableChange)) this.#cableChange = null;
  }

  /** Runs a change's due steps; whether it ended long enough ago to leave the state. */
  #stepped(change: RunningChange<{ phase: NetworkChange['phase'] }>): boolean {
    const now = this.now();
    for (;;) {
      change.steps.sort((a, b) => a.at - b.at);
      const next = change.steps[0];
      if (!next || next.at > now) break;
      change.steps.shift();
      next.run();
    }
    return change.endedAt !== null && now - change.endedAt >= this.timings.keepMs;
  }

  /** One network change at a time, Wi-Fi or cable (NM-02). */
  #notBusy(path: string): void {
    this.#advance();
    const running = [this.#change, this.#cableChange].some((c) => c && !ENDED.has(c.view.phase));
    if (running) throw new ManagerCallError(path, 409, 'busy', 'manager: 409 busy');
  }

  #route(path: string): void {
    if (this.older) throw new ManagerCallError(path, 404, 'not_found', 'manager: 404 not found');
  }

  #wifi(path: string): void {
    if (this.wifiMissing) throw new ManagerCallError(path, 409, 'no_wifi', 'manager: 409 no_wifi');
  }

  #network(ssid: string): FakeWifi | undefined {
    return this.networks.find((n) => n.ssid === ssid);
  }

  #nextId(): string {
    this.#ids += 1;
    return `c-fake${this.#ids.toString(36).padStart(6, '0')}`;
  }

  #iso(ms: number): string {
    return new Date(ms).toISOString();
  }
}
