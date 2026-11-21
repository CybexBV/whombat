/**
 * The Bluetooth fixtures (dev only, CG-27, CG-211): the chip on the claim screens and the desk (one device connected,
 * none, two, switched off), and every step of the sheet (the paired devices, read-only, nothing paired, many, a
 * connect running and one that didn't, Remove, looking, found, nothing found, each pairing phase, each failure, the
 * adapter missing or switched off, a refusal, an answer that can't be read). A Z13 on a desk: a keyboard, headphones,
 * a mouse and a speaker nearby. `bt-*` sit on the claim screens' stage and `desk-bt-*` on the desk's; the shots take
 * both at 1280×800, 2560×1600 and 1024×768.
 */
import type { ConsoleState } from '../lib/api';
import type { BluetoothDevice, BluetoothPairing } from '../lib/bluetooth';
import type { BluetoothWorld, NearbyDevice } from './bluetoothDemo';
import { DESK_FIXTURES } from './deskFixtures';
import type { Fixture } from './fixtures';

const NOW = '2026-10-20T12:34:20Z';

const KEYCHRON: BluetoothDevice = {
  address: 'F4:7A:11:0B:32:C9',
  name: 'Keychron K3',
  kind: 'keyboard',
  connected: true,
  battery: 80,
};
const SONY: BluetoothDevice = {
  address: 'AC:80:0A:5E:21:4D',
  name: 'WH-1000XM5',
  kind: 'headphones',
  connected: false,
};

/** The devices around the desk, in pairing mode, as the scan finds them (the Pixel 9 beside them never shows). */
const NEARBY: NearbyDevice[] = [
  {
    address: 'D3:4C:91:7E:08:A2',
    name: 'MX Master 3S',
    kind: 'mouse',
    connected: false,
    signal: 4,
    pairs: 'plain',
  },
  {
    address: '7C:C3:A1:5D:9B:14',
    name: 'Magic Keyboard',
    kind: 'keyboard',
    connected: false,
    signal: 3,
    pairs: 'code',
  },
  {
    address: 'B8:F6:53:0C:44:E1',
    name: 'JBL Flip 6',
    kind: 'speaker',
    connected: false,
    signal: 3,
    pairs: 'plain',
  },
  {
    address: '0C:A6:94:2B:7F:30',
    name: 'Echo Show 5',
    kind: 'speaker',
    connected: false,
    signal: 2,
    pairs: 'confirm',
  },
  {
    address: '4C:87:5D:19:E2:6B',
    name: 'Xbox Wireless Controller',
    kind: 'gamepad',
    connected: false,
    signal: 2,
    pairs: 'rejected',
  },
  {
    address: '28:11:A5:C3:90:DE',
    name: 'Jabra Evolve2 65',
    kind: 'headset',
    connected: false,
    signal: 1,
    pairs: 'timeout',
  },
];

const ADAPTER = { name: 'whombat', powered: true };

const world = (p: Partial<BluetoothWorld> = {}): BluetoothWorld => ({
  adapter: ADAPTER,
  paired: [KEYCHRON, SONY],
  nearby: NEARBY,
  mayChange: true,
  ...p,
});

/** A pairing of one of the devices nearby in one phase (the sheet's step follows its id). */
function pairing(name: string, p: Partial<BluetoothPairing>): BluetoothPairing {
  const d = NEARBY.find((x) => x.name === name);
  if (!d) throw new Error(`no device ${name}`);
  return {
    id: 'p-fixture01',
    address: d.address,
    name: d.name,
    kind: d.kind,
    phase: 'pairing',
    deadline: '2026-10-20T12:36:20Z',
    ...p,
  };
}

/** The sheet open on a frozen pairing. */
const showing = (name: string, p: Partial<BluetoothPairing>) =>
  ({
    bluetooth: world({ pairing: pairing(name, p), frozen: true }),
    bluetoothSheet: { open: true, step: { kind: 'pairing', id: 'p-fixture01' } },
  }) as const;

const FOOTER =
  'Whombat appliance. There is no login on this console.\nFor local recovery, restart and hold Space to open the boot menu, then choose\n"Whombat Recovery".';

function claim(state: NonNullable<ConsoleState['claim']>['state']) {
  const s: ConsoleState = {
    mode: 'console',
    now: NOW,
    footer: FOOTER,
    desk: null,
    claim: {
      state,
      code: state === 'claimable' ? 'KXQM' : '',
      claimUrl: 'app.whombat.com/claim',
      appUrl: 'app.whombat.com',
      retryAt: null,
      burrows: state === 'claimed' ? { first: 'Lumio BV', more: 0 } : null,
    },
    network: { online: true, via: 'wifi', ssid: 'Home', wifiMissing: null },
  };
  return [{ at: 0, state: s }];
}

/** A desk fixture's state, with the network chip beside the Bluetooth one. */
function deskOf(name: string) {
  const f = DESK_FIXTURES[name];
  if (!f) throw new Error(`no desk fixture ${name}`);
  return f.timeline.map((t) =>
    t.state.mode === 'console'
      ? {
          ...t,
          state: { ...t.state, network: { online: true, via: 'wifi', ssid: 'Home', wifiMissing: null } },
        }
      : t,
  ) as Fixture['timeline'];
}

const LOCKED = deskOf('desk-glance');
const UNLOCKED = deskOf('desk-glance-unlocked');
const FOREVER = 3_600_000;
const open = { open: true } as const;

const MANY: BluetoothDevice[] = [
  KEYCHRON,
  { address: 'D3:4C:91:7E:08:A2', name: 'MX Master 3S', kind: 'mouse', connected: true, battery: 55 },
  { address: 'B8:F6:53:0C:44:E1', name: 'JBL Flip 6', kind: 'speaker', connected: true },
  SONY,
  { address: '28:11:A5:C3:90:DE', name: 'Jabra Evolve2 65', kind: 'headset', connected: false },
  { address: '4C:87:5D:19:E2:6B', name: 'Xbox Wireless Controller', kind: 'gamepad', connected: false },
  {
    address: '60:AB:D2:41:7C:05',
    name: 'Logitech K380 Multi-Device Bluetooth Keyboard',
    kind: 'keyboard',
    connected: false,
  },
  { address: '9E:13:5A:B0:22:F8', name: 'Pen', kind: 'other', connected: false },
];

export const BLUETOOTH_FIXTURES: Record<string, Fixture> = {
  // Where the sheet opens from (CG-202)
  'desk-bt-chip': {
    note: 'The locked desk with the Bluetooth chip: the keyboard is connected',
    bluetooth: world({ mayChange: false }),
    timeline: LOCKED,
  },
  'desk-bt-chip-none': {
    note: 'The unlocked desk, nothing connected: the mark alone',
    bluetooth: world({ paired: [{ ...KEYCHRON, connected: false }, SONY] }),
    timeline: UNLOCKED,
  },
  'desk-bt-chip-two': {
    note: 'Two connected: “2 devices”',
    bluetooth: world({ paired: [KEYCHRON, { ...SONY, connected: true, battery: 40 }] }),
    timeline: UNLOCKED,
  },
  'desk-bt-chip-off': {
    note: 'Bluetooth switched off: the mark struck through',
    bluetooth: world({ adapter: { name: 'whombat', powered: false }, missing: 'disabled' }),
    timeline: UNLOCKED,
  },
  'desk-bt-chip-time': {
    note: '“Only the time” with both chips',
    bluetooth: world({ mayChange: false }),
    timeline: deskOf('desk-glance-time'),
  },
  'bt-claimable-chip': {
    note: 'The claim code with the network chip and the Bluetooth chip',
    bluetooth: world({ paired: [] }),
    timeline: claim('claimable'),
  },
  'bt-claimed-chip': {
    note: 'Claimed (no desk yet) with both chips',
    bluetooth: world({ mayChange: false }),
    timeline: claim('claimed'),
  },

  // The paired devices (CG-205, CG-206)
  'desk-bt-list': {
    note: 'The sheet on an unlocked desk: Disconnect, Connect, Remove, Add a device',
    bluetooth: world(),
    bluetoothSheet: open,
    timeline: UNLOCKED,
  },
  'desk-bt-readonly': {
    note: 'The sheet on a locked desk: read-only, unlock or use the app (BT-02)',
    bluetooth: world({ mayChange: false }),
    bluetoothSheet: open,
    timeline: LOCKED,
  },
  'desk-bt-empty': {
    note: 'Nothing paired yet',
    bluetooth: world({ paired: [] }),
    bluetoothSheet: open,
    timeline: UNLOCKED,
  },
  'desk-bt-many': {
    note: 'Eight paired devices: the list scrolls, a long name gives way',
    bluetooth: world({ paired: MANY }),
    bluetoothSheet: open,
    timeline: UNLOCKED,
  },
  'desk-bt-connecting': {
    note: 'Connect pressed on the headphones: “Connecting…”',
    bluetooth: world(),
    bluetoothSheet: open,
    timeline: UNLOCKED,
  },
  'desk-bt-connect-failed': {
    note: 'The headphones didn’t connect (switched off)',
    bluetooth: world({ connectFails: ['WH-1000XM5'] }),
    bluetoothSheet: { open: true, error: 'Couldn’t connect to WH-1000XM5. Switch it on and try again.' },
    timeline: UNLOCKED,
  },
  'desk-bt-remove': {
    note: 'Remove Keychron K3?',
    bluetooth: world(),
    bluetoothSheet: { open: true, step: { kind: 'remove', device: KEYCHRON } },
    timeline: UNLOCKED,
  },
  'bt-claimable': {
    note: 'The sheet on a box not claimed yet: anyone at the screen may add a device (BT-02)',
    bluetooth: world({ paired: [] }),
    bluetoothSheet: open,
    timeline: claim('claimable'),
  },

  // Add a device (CG-206, CG-207)
  'desk-bt-looking': {
    note: 'Add a device: looking, nothing found yet',
    bluetooth: world({ findMs: FOREVER }),
    bluetoothSheet: { open: true, step: { kind: 'add' } },
    timeline: UNLOCKED,
  },
  'desk-bt-found': {
    note: 'Add a device: found nearby, still looking',
    bluetooth: world({ findMs: 150 }),
    bluetoothSheet: { open: true, step: { kind: 'add' } },
    timeline: UNLOCKED,
  },
  'desk-bt-found-ended': {
    note: 'Add a device: the minute is over, Look again',
    bluetooth: world({ findMs: 100, scanS: 2 }),
    bluetoothSheet: { open: true, step: { kind: 'add' } },
    timeline: UNLOCKED,
  },
  'desk-bt-nothing': {
    note: 'Add a device: nothing found',
    bluetooth: world({ nearby: [], scanS: 1 }),
    bluetoothSheet: { open: true, step: { kind: 'add' } },
    timeline: UNLOCKED,
  },
  'desk-bt-busy': {
    note: 'Add a device: another pairing still runs (the app’s)',
    bluetooth: world({ findMs: 100 }),
    bluetoothSheet: {
      open: true,
      step: { kind: 'add' },
      error: 'Another device is pairing. Try again in a moment.',
    },
    timeline: UNLOCKED,
  },
  'bt-claimable-found': {
    note: 'Add a device over the claim code (1024×768 stage)',
    bluetooth: world({ paired: [], findMs: 150 }),
    bluetoothSheet: { open: true, step: { kind: 'add' } },
    timeline: claim('claimable'),
  },

  // A pairing, phase by phase (CG-207, CG-208)
  'desk-bt-pairing': {
    note: 'Pairing with MX Master 3S…',
    ...showing('MX Master 3S', {}),
    timeline: UNLOCKED,
  },
  'desk-bt-code': {
    note: 'Type the code on the Magic Keyboard: nothing typed yet',
    ...showing('Magic Keyboard', { phase: 'code', code: '482913', typed: 0 }),
    timeline: UNLOCKED,
  },
  'desk-bt-code-typed': {
    note: 'The code: three digits typed',
    ...showing('Magic Keyboard', { phase: 'code', code: '482913', typed: 3 }),
    timeline: UNLOCKED,
  },
  'desk-bt-code-four': {
    note: 'A four-digit code from a keyboard that doesn’t say what is typed',
    ...showing('Magic Keyboard', { phase: 'code', code: '0000' }),
    timeline: UNLOCKED,
  },
  'bt-claimable-code': {
    note: 'The code over the claim screen (1024×768 stage)',
    bluetooth: world({
      paired: [],
      pairing: pairing('Magic Keyboard', { phase: 'code', code: '482913', typed: 4 }),
      frozen: true,
    }),
    bluetoothSheet: { open: true, step: { kind: 'pairing', id: 'p-fixture01' } },
    timeline: claim('claimable'),
  },
  'desk-bt-confirm': {
    note: 'Does Echo Show 5 show 731264? Yes / No',
    ...showing('Echo Show 5', { phase: 'confirm', code: '731264' }),
    timeline: UNLOCKED,
  },
  'desk-bt-connecting-pair': {
    note: 'Paired, connecting (still “Pairing with …”)',
    ...showing('JBL Flip 6', { phase: 'connecting' }),
    timeline: UNLOCKED,
  },
  'desk-bt-done': {
    note: 'Magic Keyboard is ready.',
    ...showing('Magic Keyboard', { phase: 'done' }),
    timeline: UNLOCKED,
  },
  'desk-bt-rejected': {
    note: 'The controller didn’t accept the pairing',
    ...showing('Xbox Wireless Controller', { phase: 'failed', failure: 'rejected' }),
    timeline: UNLOCKED,
  },
  'desk-bt-timeout': {
    note: 'The headset didn’t answer in time',
    ...showing('Jabra Evolve2 65', { phase: 'failed', failure: 'timeout' }),
    timeline: UNLOCKED,
  },
  'desk-bt-gone': {
    note: 'The speaker isn’t nearby any more',
    ...showing('JBL Flip 6', { phase: 'failed', failure: 'not_found' }),
    timeline: UNLOCKED,
  },
  'desk-bt-failed': {
    note: 'Pairing didn’t work',
    ...showing('MX Master 3S', { phase: 'failed', failure: 'failed' }),
    timeline: UNLOCKED,
  },
  'desk-bt-canceled': {
    note: 'Pairing was stopped (in the app)',
    ...showing('MX Master 3S', { phase: 'failed', failure: 'canceled' }),
    timeline: UNLOCKED,
  },

  // Bluetooth that can't be used, or read (CG-209)
  'desk-bt-no-driver': {
    note: 'An adapter without a driver',
    bluetooth: world({ adapter: null, missing: 'no_driver', paired: [] }),
    bluetoothSheet: open,
    timeline: UNLOCKED,
  },
  'desk-bt-off': {
    note: 'Bluetooth switched off: the paired devices, no buttons',
    bluetooth: world({ adapter: { name: 'whombat', powered: false }, missing: 'disabled' }),
    bluetoothSheet: open,
    timeline: UNLOCKED,
  },
  'desk-bt-unreadable': {
    note: 'Bluetooth couldn’t be read',
    bluetooth: world({ unreadable: true }),
    bluetoothSheet: open,
    timeline: UNLOCKED,
  },

  // Live: open the chip and pair (Magic Keyboard types its code, Echo Show 5 asks, the controller refuses)
  'desk-bt-live': {
    note: 'Live: the demo world on an unlocked desk (try each device)',
    bluetooth: world(),
    timeline: UNLOCKED,
  },
};
