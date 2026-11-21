/**
 * The machine in the demo world (hardware-support-android.md AP-3262): the web's fake machines (`createFakeNetwork`,
 * `fakeHardware`, `@whombat/client/host/fake`) answering `host.network`, `host.wifi.*` and `host.hardware`. It starts as a ROG Flow Z13-like laptop on its USB cable and on “Home” Wi-Fi; joins run `applying →
 * confirming → committed` in a few seconds, a wrong password fails at once and keeps nothing, and the open “Café
 * Wombat” has no internet, so joining it without the cable goes back. Use Wi-Fi only switches its cable off (and Use the
 * cable again on), and six servers find its new address one by one. Its Bluetooth is the web's fake too
 * (`createFakeBluetooth`, bluetooth-android.md AP-3759): “Keychron K3” and “WH-1000XM5” paired, five devices to find.
 *
 * Settings → This Whombat takes `?machine=<state>` in the demo world (`whombat://settings/whombat?machine=vm`) to start
 * over as another machine, for checks on the emulator: `MACHINE_DEMO_STATES`. Pure TypeScript.
 */
import type { BluetoothApi, HardwareLoader, NetworkApi } from '@whombat/client';
import {
  createFakeBluetooth,
  createFakeNetwork,
  type FakeBluetooth,
  type FakeMachine,
  type FakeNetwork,
  type FakeNetworkSnapshot,
  fakeBluetoothApi,
  fakeHardware,
  fakeNetworkApi,
  fakeNetworkSeed,
} from '@whombat/client/host/fake';

export const MACHINE_DEMO_STATES = [
  /** The Z13 on its USB Ethernet adapter and on Home Wi-Fi (the start). */
  'z13',
  /** The Z13 with the cable unplugged: only Wi-Fi, so the guard has something to protect. */
  'wifi',
  /** The Z13 on Wi-Fi only, its cable switched off but still plugged in (network-move-app.md). */
  'wifionly',
  /** The Z13 on Café Wombat, which has no internet, and no cable: it can't reach Whombat. */
  'offline',
  /** A QEMU/KVM virtual machine: a cable, no Wi-Fi card, no Bluetooth. */
  'vm',
  /** A small PC whose Wi-Fi card has no driver (and its Bluetooth is switched off), on a cable. */
  'nodriver',
] as const;
export type MachineDemoState = (typeof MACHINE_DEMO_STATES)[number];

export function isMachineDemoState(value: unknown): value is MachineDemoState {
  return typeof value === 'string' && (MACHINE_DEMO_STATES as readonly string[]).includes(value);
}

/** Which of the fake machines a state is. */
export function machineOf(state: MachineDemoState): FakeMachine {
  return state === 'vm' ? 'vm' : state === 'nodriver' ? 'nodriver' : 'z13';
}

/** The fake network's start for a state. */
export function machineDemoSeed(state: MachineDemoState): FakeNetworkSnapshot {
  const seed = fakeNetworkSeed(machineOf(state));
  if (state === 'wifi') return { ...seed, cable: false };
  if (state === 'wifionly') return { ...seed, wifiOnly: true };
  if (state === 'offline')
    return {
      ...seed,
      cable: false,
      connected: 'Café Wombat',
      saved: [...seed.saved, { ssid: 'Café Wombat', security: 'open' }],
    };
  return seed;
}

export interface DemoMachineOptions {
  state?: MachineDemoState;
  /** The clock (epoch ms; default `Date.now`): the change's deadline and phases are real times, as on a box. */
  now?: () => number;
  /** How long a scan takes (a box waits for a fresh one). */
  scanMs?: number;
  /** How long joining and the guard's check take. */
  applyMs?: number;
  confirmMs?: number;
  /** How long a pairing takes before its code, question or end, a digit typed, and connecting after (the fake's). */
  pairMs?: number;
  typeMs?: number;
  connectMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export interface DemoMachine {
  /** `host.network` and `host.wifi.*`. */
  network: NetworkApi;
  /** `host.hardware`, collected now. */
  hardware: HardwareLoader;
  /** `host.bluetooth*`. */
  bluetooth: BluetoothApi;
  state(): MachineDemoState;
  /** The fake's own side (tests plug the cable in and out). */
  fake(): FakeNetwork;
  /** The fake Bluetooth's own side. */
  fakeBluetooth(): FakeBluetooth;
  /** Start over as another machine. */
  reset(state: MachineDemoState): void;
  /** After a reset (NETWORK and HARDWARE read again). */
  onChange(listener: () => void): () => void;
}

export function createDemoMachine(options: DemoMachineOptions = {}): DemoMachine {
  const now = options.now ?? Date.now;
  const scanMs = options.scanMs ?? 900;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const listeners = new Set<() => void>();
  let state: MachineDemoState = options.state ?? 'z13';
  let fake!: FakeNetwork;
  let bt!: FakeBluetooth;
  const make = () => {
    fake = createFakeNetwork({
      machine: machineOf(state),
      initial: machineDemoSeed(state),
      now,
      ...(options.applyMs === undefined ? {} : { applyMs: options.applyMs }),
      ...(options.confirmMs === undefined ? {} : { confirmMs: options.confirmMs }),
    });
    bt = createFakeBluetooth({
      machine: machineOf(state),
      now,
      ...(options.pairMs === undefined ? {} : { pairMs: options.pairMs }),
      ...(options.typeMs === undefined ? {} : { typeMs: options.typeMs }),
      ...(options.connectMs === undefined ? {} : { connectMs: options.connectMs }),
    });
  };
  make();
  const api = () => fakeNetworkApi(fake);
  const btApi = () => fakeBluetoothApi(bt);
  const later = <T>(work: () => Promise<T>): Promise<T> =>
    scanMs > 0 ? new Promise<void>((resolve) => setTimer(() => resolve(), scanMs)).then(work) : work();
  const network: NetworkApi = {
    state: () => api().state(),
    scan: () => later(() => api().scan()),
    join: (input) => api().join(input),
    forget: (ssid) => api().forget(ssid),
    setCable: (use) => api().setCable(use),
  };
  // The fake of the moment: a reset makes a new one.
  const bluetooth: BluetoothApi = {
    state: () => btApi().state(),
    scan: () => btApi().scan(),
    pair: (address) => btApi().pair(address),
    confirm: (pairingId, accept) => btApi().confirm(pairingId, accept),
    cancel: (pairingId) => btApi().cancel(pairingId),
    connect: (address) => btApi().connect(address),
    disconnect: (address) => btApi().disconnect(address),
    forget: (address) => btApi().forget(address),
  };
  return {
    network,
    hardware: async () => ({ hardware: fakeHardware(machineOf(state), now()) }),
    bluetooth,
    state: () => state,
    fake: () => fake,
    fakeBluetooth: () => bt,
    reset(next) {
      state = next;
      make();
      for (const l of [...listeners]) l();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let demo: DemoMachine | null = null;

/** The demo world's one machine, made on first use; it keeps its state while the app runs. */
export function demoMachine(): DemoMachine {
  demo ??= createDemoMachine();
  return demo;
}
