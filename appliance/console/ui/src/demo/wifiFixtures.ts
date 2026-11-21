/**
 * The Wi-Fi fixtures (dev only, CG-27, CG-110): the network chip on the claim, claimed and desk screens, the waiting
 * scene's *Choose Wi-Fi*, every step of the sheet (the list, looking, nothing nearby, read-only, no card, the password
 * with the keyboard, another network, Forget, a join and a forget through Whombat's phases, the refusals), and the
 * installer's Wi-Fi step. A Z13 without its USB Ethernet adapter: no cable, a Wi-Fi card, the networks of an office.
 * `wifi-*` and `desk-wifi-*` sit on the claim screens' and the desk's stages; the shots take both at 1280×800,
 * 2560×1600 and 1024×768.
 */
import type { ConsoleState, InstallerState } from '../lib/api';
import type { HostNetwork, NetworkChange, WifiNetwork } from '../lib/network';
import { DESK_FIXTURES } from './deskFixtures';
import type { Fixture } from './fixtures';
import type { WifiWorld } from './wifiDemo';

const NOW = '2026-10-20T12:34:20Z';

const net = (
  ssid: string,
  security: WifiNetwork['security'],
  signal: WifiNetwork['signal'],
): WifiNetwork => ({
  ssid,
  security,
  signal,
  saved: false,
  connected: false,
});

/** An office in Amsterdam: two saved networks, a guest one, a company one, the neighbours'. */
const NEARBY: WifiNetwork[] = [
  net('Home', 'psk', 4),
  net('Office', 'psk', 3),
  net('Lumio Guest', 'open', 3),
  net('Lumio', 'enterprise', 3),
  net('FRITZ!Box 7590 KQ', 'psk', 2),
  net('Ziggo4F2A1', 'psk', 1),
  net('HP-Print-3C-LaserJet', 'other', 1),
  net('Café de Wombat ☕', 'open', 0),
];

/** A new box on the Z13: no cable, the Wi-Fi card not connected yet, not claimed (the screen may choose, HD-07). */
const OFFLINE: HostNetwork = {
  online: false,
  checkedAt: '2026-10-20T12:34:00Z',
  wired: [],
  wifi: { interface: 'wlan0', state: 'disconnected', saved: [] },
  change: null,
};

/** A claimed box on Wi-Fi “Home”, the USB adapter unplugged. */
const ON_HOME: HostNetwork = {
  online: true,
  checkedAt: '2026-10-20T12:34:00Z',
  wired: [{ interface: 'enp0s20f0u2', connected: false }],
  wifi: {
    interface: 'wlan0',
    state: 'connected',
    ssid: 'Home',
    signal: 4,
    address: '192.168.1.40',
    saved: [
      { ssid: 'Home', security: 'psk' },
      { ssid: 'Office', security: 'psk' },
    ],
  },
  change: null,
};

/** On a cable, the Wi-Fi saved for when it is unplugged. */
const ON_CABLE: HostNetwork = {
  ...ON_HOME,
  wired: [{ interface: 'enp0s20f0u2', connected: true, address: '192.168.1.23' }],
  wifi: { interface: 'wlan0', state: 'disconnected', saved: [{ ssid: 'Home', security: 'psk' }] },
};

const NO_CARD: HostNetwork = { ...OFFLINE, wifi: null, wifiMissing: 'no_adapter' };

/** The box on the calm glance's top bar (CG-350): on Wi-Fi “Ziggo-5G”, or on it without the internet, or on a cable. */
export const CALM_WIFI = (online = true, cable = false): WifiWorld => ({
  network: cable
    ? { ...ON_CABLE, online }
    : {
        ...ON_HOME,
        online,
        wifi: { ...(ON_HOME.wifi as NonNullable<HostNetwork['wifi']>), ssid: 'Ziggo-5G' },
      },
  mayChange: true,
  scan: NEARBY,
});

const world = (network: HostNetwork, p: Partial<WifiWorld> = {}): WifiWorld => ({
  network,
  mayChange: true,
  scan: NEARBY,
  wrong: 'wrong-password',
  ...p,
});

const FOOTER =
  'Whombat appliance. There is no login on this console.\nFor local recovery, restart and hold Space to open the boot menu, then choose\n"Whombat Recovery".';

function claim(state: NonNullable<ConsoleState['claim']>['state'], p: Partial<ConsoleState['claim']> = {}) {
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
      ...p,
    },
  };
  return [{ at: 0, state: s }];
}

/** A desk fixture's state as the desk fixtures have it. */
function deskOf(name: string) {
  const f = DESK_FIXTURES[name];
  if (!f) throw new Error(`no desk fixture ${name}`);
  return f.timeline;
}

const GiB = 1024 ** 3;

/** The installer on the Z13: every check fine but the network (no cable), one disk. */
function installer(p: Partial<InstallerState> = {}): { at: number; state: InstallerState }[] {
  const s: InstallerState = {
    mode: 'installer',
    platform: 'self-installed',
    storage: 'host-encrypted',
    environment: 'dev',
    release: 'whombat-20261021.1',
    appUrl: 'dev.whombat.com',
    preflight: {
      status: 'done',
      checks: [
        { id: 'uefi', status: 'ok', value: 'UEFI' },
        { id: 'cpu', status: 'ok', value: '16 cores' },
        { id: 'memory', status: 'ok', value: '32 GiB' },
        { id: 'disk', status: 'ok', value: 'nvme0n1' },
        { id: 'network', status: 'warn', value: '' },
        { id: 'reach-api', status: 'warn', value: 'api-dev.whombat.com' },
        { id: 'reach-updates', status: 'warn', value: 'updates-dev.whombat.com' },
        { id: 'reach-relay', status: 'warn', value: 'relay-dev.whombat.com' },
      ],
      disks: [
        {
          path: '/dev/nvme0n1',
          name: 'nvme0n1',
          model: 'Micron 2500 1TB',
          sizeBytes: 954 * GiB,
          eligible: true,
          reason: '',
        },
      ],
    },
    install: { status: 'idle', disk: null, step: null, percent: 0, log: [], error: '' },
    wired: false,
    ...p,
  };
  return [{ at: 0, state: s }];
}

/** A change the sheet follows (it started it: the sheet's step carries the id). */
function change(p: Partial<NetworkChange>): NetworkChange {
  return {
    id: 'c-fixture01',
    kind: 'join',
    ssid: 'Office',
    phase: 'applying',
    deadline: '2026-10-20T12:36:20Z',
    previous: 'Home',
    ...p,
  };
}

const following = (c: NetworkChange) =>
  ({ open: true, step: { kind: 'change', id: c.id, ssid: c.ssid, hidden: false } }) as const;

const LOOKING_FOREVER = 3_600_000;

export const WIFI_FIXTURES: Record<string, Fixture> = {
  // Where the sheet opens from (CG-104…CG-106)
  'wifi-waiting': {
    note: 'Waiting, no cable: “Choose Wi-Fi” and the chip (No network)',
    wifi: world(OFFLINE),
    timeline: claim('waiting'),
  },
  'wifi-waiting-no-card': {
    note: 'Waiting on a machine without a Wi-Fi card: the cable hint as before',
    wifi: world(NO_CARD),
    timeline: claim('waiting'),
  },
  'wifi-claimable-chip': {
    note: 'The claim code with the chip (on a cable)',
    wifi: world(ON_CABLE),
    timeline: claim('claimable'),
  },
  'wifi-claimed-chip': {
    note: 'Claimed with the chip (Wi-Fi “Home”)',
    wifi: world(ON_HOME, { mayChange: false }),
    timeline: claim('claimed'),
  },
  'wifi-claimed-offline': {
    note: 'Claimed, Whombat out of reach: the chip turns amber',
    wifi: world({ ...ON_HOME, online: false }),
    timeline: claim('claimed'),
  },
  'desk-wifi-chip': {
    note: 'The desk, locked, with the network chip beside the lock',
    wifi: world(ON_HOME, { mayChange: false }),
    timeline: deskOf('desk-glance'),
  },
  'desk-wifi-chip-unlocked': {
    note: 'The desk, unlocked, with the network chip',
    wifi: world(ON_HOME),
    timeline: deskOf('desk-glance-unlocked'),
  },

  // The sheet (CG-107…CG-109)
  'wifi-list': {
    note: 'The sheet on a new box: the networks nearby, Other network…',
    wifi: world(OFFLINE),
    wifiSheet: { open: true },
    timeline: claim('waiting'),
  },
  'wifi-looking': {
    note: 'The sheet while it looks for networks',
    wifi: world(OFFLINE, { scanMs: LOOKING_FOREVER }),
    wifiSheet: { open: true },
    timeline: claim('waiting'),
  },
  'wifi-none': {
    note: 'The sheet, nothing nearby',
    wifi: world(OFFLINE, { scan: [] }),
    wifiSheet: { open: true },
    timeline: claim('waiting'),
  },
  'wifi-no-driver': {
    note: 'The sheet on a box whose Wi-Fi card has no driver',
    wifi: world({ ...OFFLINE, wifi: null, wifiMissing: 'no_driver' }),
    wifiSheet: { open: true },
    timeline: claim('waiting'),
  },
  'wifi-password': {
    note: 'The password with the screen’s keyboard, nothing typed',
    wifi: world(OFFLINE),
    wifiSheet: { open: true, step: { kind: 'password', ssid: 'Home', hidden: false } },
    timeline: claim('waiting'),
  },
  'wifi-password-typed': {
    note: 'The password typed, hidden',
    wifi: world(OFFLINE),
    wifiSheet: {
      open: true,
      step: { kind: 'password', ssid: 'Home', hidden: false },
      password: 'wombat-burrow-42',
    },
    timeline: claim('waiting'),
  },
  'wifi-password-shown': {
    note: 'The password typed, shown',
    wifi: world(OFFLINE),
    wifiSheet: {
      open: true,
      step: { kind: 'password', ssid: 'Home', hidden: false },
      password: 'wombat-burrow-42',
      shown: true,
    },
    timeline: claim('waiting'),
  },
  'wifi-password-symbols': {
    note: 'The keyboard’s symbols',
    wifi: world(OFFLINE),
    wifiSheet: {
      open: true,
      step: { kind: 'password', ssid: 'Home', hidden: false },
      password: 'wombat',
      shown: true,
    },
    timeline: claim('waiting'),
  },
  'wifi-password-wrong': {
    note: 'That password didn’t work (try “wrong-password” live)',
    wifi: world(OFFLINE),
    wifiSheet: {
      open: true,
      step: { kind: 'password', ssid: 'Home', hidden: false },
      password: 'wrong-password',
      error: 'That password didn’t work.',
    },
    timeline: claim('waiting'),
  },
  'wifi-other': {
    note: 'Other network: the name, password or none',
    wifi: world(OFFLINE),
    wifiSheet: { open: true, step: { kind: 'other' }, name: 'Burrow 5G' },
    timeline: claim('waiting'),
  },
  'wifi-joining': {
    note: 'Joining a network (Whombat applies it)',
    wifi: world({ ...ON_HOME, change: change({}) }),
    wifiSheet: following(change({})),
    timeline: claim('claimed'),
  },
  'wifi-confirming': {
    note: 'Joined, checking that Whombat reaches the internet there',
    wifi: world({ ...ON_HOME, change: change({ phase: 'confirming' }) }),
    wifiSheet: following(change({ phase: 'confirming' })),
    timeline: claim('claimed'),
  },
  'wifi-joined': {
    note: 'Joined',
    wifi: world({ ...ON_HOME, change: change({ phase: 'committed' }) }),
    wifiSheet: following(change({ phase: 'committed' })),
    timeline: claim('claimed'),
  },
  'wifi-reverted': {
    note: 'Joined Office, but Whombat couldn’t reach the internet there: back to Home (HD-11)',
    wifi: world({ ...ON_HOME, change: change({ phase: 'reverted', failure: 'no_internet' }) }),
    wifiSheet: following(change({ phase: 'reverted', failure: 'no_internet' })),
    timeline: claim('claimed'),
  },
  'wifi-not-found': {
    note: 'Couldn’t join: the network went away',
    wifi: world({
      ...OFFLINE,
      change: change({ ssid: 'Burrow 5G', phase: 'failed', failure: 'not_found', previous: undefined }),
    }),
    wifiSheet: following(change({ ssid: 'Burrow 5G', phase: 'failed', failure: 'not_found' })),
    timeline: claim('waiting'),
  },
  'wifi-busy': {
    note: 'Another change is still running (a refusal under the list)',
    wifi: world(ON_HOME),
    wifiSheet: { open: true, error: 'Another network change is still running. Try again in a moment.' },
    timeline: claim('claimed'),
  },
  'wifi-forget': {
    note: 'Forget a saved network?',
    wifi: world(ON_HOME),
    wifiSheet: { open: true, step: { kind: 'forget', ssid: 'Office', secured: true } },
    timeline: claim('claimed'),
  },
  'wifi-forgot': {
    note: 'Forgot a network',
    wifi: world({ ...ON_HOME, change: change({ kind: 'forget', phase: 'committed', previous: undefined }) }),
    wifiSheet: following(change({ kind: 'forget', phase: 'committed' })),
    timeline: claim('claimed'),
  },
  'desk-wifi-readonly': {
    note: 'The sheet on a locked desk that is online: read-only (HD-07)',
    wifi: world(ON_HOME, { mayChange: false }),
    wifiSheet: { open: true },
    timeline: deskOf('desk-glance'),
  },
  'desk-wifi-unlocked': {
    note: 'The sheet on an unlocked desk: switch, Forget, Other network…',
    wifi: world(ON_HOME),
    wifiSheet: { open: true },
    timeline: deskOf('desk-glance-unlocked'),
  },
  'desk-wifi-password': {
    note: 'The password and the keyboard over the desk',
    wifi: world(ON_HOME),
    wifiSheet: {
      open: true,
      step: { kind: 'password', ssid: 'FRITZ!Box 7590 KQ', hidden: false },
      password: '4217 9983',
    },
    timeline: deskOf('desk-glance-unlocked'),
  },
  'desk-wifi-reverted': {
    note: 'The desk, a switch undone (HD-11)',
    wifi: world({ ...ON_HOME, change: change({ phase: 'reverted', failure: 'no_internet' }) }),
    wifiSheet: following(change({ phase: 'reverted', failure: 'no_internet' })),
    timeline: deskOf('desk-glance-unlocked'),
  },

  // The installer's Wi-Fi step (HD-08, CG-120…)
  'installer-wifi': {
    note: 'Wi-Fi step: no cable, the networks nearby',
    wizard: { step: 'wifi' },
    wifi: world(OFFLINE),
    timeline: installer(),
  },
  'installer-wifi-looking': {
    note: 'Wi-Fi step while it looks',
    wizard: { step: 'wifi' },
    wifi: world(OFFLINE, { scanMs: LOOKING_FOREVER }),
    timeline: installer(),
  },
  'installer-wifi-password': {
    note: 'Wi-Fi step: the password with the keyboard',
    wizard: { step: 'wifi' },
    wifi: world(OFFLINE),
    wifiSheet: { step: { kind: 'password', ssid: 'Home', hidden: false }, password: 'wombat-burrow-42' },
    timeline: installer(),
  },
  'installer-wifi-wrong': {
    note: 'Wi-Fi step: that password didn’t work',
    wizard: { step: 'wifi' },
    wifi: world(OFFLINE),
    wifiSheet: {
      step: { kind: 'password', ssid: 'Home', hidden: false },
      password: 'wrong-password',
      error: 'That password didn’t work.',
    },
    timeline: installer(),
  },
  'installer-wifi-other': {
    note: 'Wi-Fi step: another network',
    wizard: { step: 'wifi' },
    wifi: world(OFFLINE),
    wifiSheet: { step: { kind: 'other' }, name: 'Burrow 5G' },
    timeline: installer(),
  },
  'installer-wifi-joined': {
    note: 'Wi-Fi step: joined, the checks again over it',
    wizard: { step: 'wifi' },
    wifi: world({
      ...OFFLINE,
      online: true,
      wifi: {
        interface: 'wlan0',
        state: 'connected',
        ssid: 'Home',
        signal: 4,
        saved: [{ ssid: 'Home', security: 'psk' }],
      },
    }),
    timeline: installer({
      preflight: {
        status: 'done',
        checks: [
          { id: 'uefi', status: 'ok', value: 'UEFI' },
          { id: 'cpu', status: 'ok', value: '16 cores' },
          { id: 'memory', status: 'ok', value: '32 GiB' },
          { id: 'disk', status: 'ok', value: 'nvme0n1' },
          { id: 'network', status: 'ok', value: '192.168.1.57' },
          { id: 'reach-api', status: 'ok', value: 'api-dev.whombat.com' },
          { id: 'reach-updates', status: 'ok', value: 'updates-dev.whombat.com' },
          { id: 'reach-relay', status: 'ok', value: 'relay-dev.whombat.com' },
        ],
        disks: [
          {
            path: '/dev/nvme0n1',
            name: 'nvme0n1',
            model: 'Micron 2500 1TB',
            sizeBytes: 954 * GiB,
            eligible: true,
            reason: '',
          },
        ],
      },
    }),
  },
  'installer-wifi-no-card': {
    note: 'Wi-Fi step on a machine without a Wi-Fi card',
    wizard: { step: 'wifi' },
    wifi: world(NO_CARD, { installerMissing: 'no_adapter' }),
    timeline: installer(),
  },
  'installer-wifi-checks': {
    note: 'The checks with no cable (before the Wi-Fi step): STEP 1 OF 3',
    wizard: { step: 'checks' },
    wifi: world(OFFLINE),
    timeline: installer(),
  },
};
