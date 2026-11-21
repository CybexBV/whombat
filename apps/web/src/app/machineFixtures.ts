/**
 * The machine in fixture mode and the fake managed world (hardware-support-web.md AP-3221): its hardware report, its
 * network and its Bluetooth, from `@whombat/client/host/fake`. `VITE_FIXTURE_MACHINE` (option `machine`, the fake world's `machine`
 * fault, or `localStorage['whombat:fixture-machine']` for the visual suite) picks it: `z13` (a ROG Flow Z13-like laptop
 * on a cable and “Home” Wi-Fi), `vm` (a QEMU/KVM VM, no Wi-Fi card) or `nodriver` (a PC whose Wi-Fi card has no
 * driver). Without one there is no machine to ask, so This Whombat stays as the mocks draw it. In development the
 * network's side is `window.__WHOMBAT_NETWORK__` (`plugCable(false)` makes the guard depend on the Wi-Fi), and
 * Bluetooth's (bluetooth-web.md AP-3711) `window.__WHOMBAT_BLUETOOTH__`, whose `advance(ms)` moves its clock on (the
 * visual suite's clock stands still, so looking and pairing go on only when it says so).
 */
import type { BluetoothApi, HardwareLoader, NetworkApi } from '@whombat/client';
import {
  createFakeBluetooth,
  createFakeNetwork,
  FAKE_MACHINES,
  type FakeBluetooth,
  type FakeMachine,
  type FakeNetwork,
  fakeBluetoothApi,
  fakeHardware,
  fakeNetworkApi,
} from '@whombat/client/host/fake';

/** Where the visual suite picks a machine before the page loads (fixture mode only). */
export const MACHINE_FIXTURE_KEY = 'whombat:fixture-machine';

const known = (v: unknown): v is FakeMachine => FAKE_MACHINES.includes(v as FakeMachine);

/** The machine from `machine`, else `VITE_FIXTURE_MACHINE`, else the page's storage; null: none. */
export function machineFixtureKind(option?: FakeMachine | false | null): FakeMachine | null {
  if (option === false) return null;
  if (option) return option;
  const env = import.meta.env.VITE_FIXTURE_MACHINE;
  if (known(env)) return env;
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(MACHINE_FIXTURE_KEY);
  return known(stored) ? stored : null;
}

export interface MachineFixture {
  network: NetworkApi;
  hardware: HardwareLoader;
  bluetooth: BluetoothApi;
  fake: FakeNetwork;
  fakeBluetooth: FakeBluetooth;
}

/** The fixture machine's Bluetooth from the page (development): the fake and its clock. */
export interface BluetoothFixtureHandle {
  fake: FakeBluetooth;
  /** Moves the fake's clock on by `ms`: what was found meanwhile, the digits typed, the pairing's end. */
  advance(ms: number): void;
}

/** The page's own machine: one per page, however often its services are made (StrictMode). */
let pageMachine: { kind: FakeMachine; value: MachineFixture } | null = null;

/** The fixture world's machine and Mara's ops on it; null without one. */
export function machineFixture(option?: FakeMachine | false): MachineFixture | null {
  const kind = machineFixtureKind(option);
  if (!kind) return null;
  if (option === undefined) {
    if (pageMachine?.kind !== kind) pageMachine = { kind, value: newMachine(kind) };
    return pageMachine.value;
  }
  return newMachine(kind);
}

function newMachine(kind: FakeMachine): MachineFixture {
  const fake = createFakeNetwork({ machine: kind });
  let skew = 0;
  const fakeBluetooth = createFakeBluetooth({ machine: kind, now: () => Date.now() + skew });
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const w = window as unknown as {
      __WHOMBAT_NETWORK__?: FakeNetwork;
      __WHOMBAT_BLUETOOTH__?: BluetoothFixtureHandle;
    };
    w.__WHOMBAT_NETWORK__ = fake;
    w.__WHOMBAT_BLUETOOTH__ = {
      fake: fakeBluetooth,
      advance: (ms) => {
        skew += ms;
      },
    };
  }
  return {
    network: fakeNetworkApi(fake),
    hardware: async () => ({ hardware: fakeHardware(kind) }),
    bluetooth: fakeBluetoothApi(fakeBluetooth),
    fake,
    fakeBluetooth,
  };
}
