/**
 * Demo fixtures (dev only, never in the production bundle): every screen and sub-state, for `?demo=<name>` and
 * `pnpm shots`. A fixture is a timeline of states (the page polls it like the real server) plus what the POSTs
 * answer.
 */

import type { BluetoothInitial } from '../bluetooth/BluetoothLayer';
import type { DeskInitial } from '../desk/Desk';
import type { RemoteHelpInitial } from '../desk/RemoteHelp';
import type {
  Check,
  ConsoleReach,
  ConsoleState,
  Disk,
  InstallerState,
  ReachLink,
  ServerState,
} from '../lib/api';
import type {
  DeskGlance,
  DeskServerPage,
  DeskServersAnswer,
  DeskSession,
  DeskTalk,
  LookResearch,
  ServerRange,
} from '../lib/desk';
import type { Wizard } from '../lib/installer';
import type { KioskOutput } from '../lib/outputs';
import type { SignIn } from '../lib/signIn';
import type { WifiInitial } from '../wifi/WifiLayer';
import type { BluetoothWorld } from './bluetoothDemo';
import { BLUETOOTH_FIXTURES } from './bluetoothFixtures';
import { CALM_FIXTURES } from './calmFixtures';
import { DESK_FIXTURES } from './deskFixtures';
import { demoQr } from './qr';
import { REMOTE_HELP_FIXTURES } from './remoteHelpFixtures';
import { SCREEN_FIXTURES } from './screenFixtures';
import type { WifiWorld } from './wifiDemo';
import { WIFI_FIXTURES } from './wifiFixtures';

export interface Fixture {
  /** States by time since the page loaded (ms); the last one whose `at` has passed is served. */
  timeline: { at: number; state: ServerState }[];
  /** Status of every POST (default 202). */
  post?: Record<string, number>;
  /** The server is away from this time on (ms). */
  awayAfter?: number;
  wizard?: Partial<Wizard>;
  /** Pretend the last key press was this long ago (burn-in). */
  idleMs?: number;
  /** The desk page's own state at the start (an open sheet, Talk, typed digits). */
  desk?: DeskInitial;
  /** The demo desk's glance once unlocked (the PIN is 123456, or 2580 for a 4-digit one). */
  unlockedGlance?: DeskGlance;
  /** The camera once unlocked (DK-28): on and seeing someone, or on and not yet; none: off. */
  camera?: 'present' | 'looking';
  /** What the demo desk answers a talk with. */
  talkAnswer?: Partial<DeskTalk>;
  /** The open conversation the demo desk gives Talk (0.108, DK-63); none: 404, as a runtime from before. */
  session?: DeskSession;
  /** The demo desk answers a wider choice with 403 `not_offered` (0.116, TF-14). */
  notOffered?: boolean;
  /** The demo desk refuses Ignore and Not now on a look (0.122, QN-20): 403 `not_allowed` or 404 `not_found`. */
  quietRefused?: 'not_allowed' | 'not_found';
  /** The demo desk refuses the assistant's step on a look (3.5, CG-376): 403 `not_allowed` or 404 `not_found`. */
  stepRefused?: 'not_allowed' | 'not_found';
  /** The demo desk takes the step (`fixing`) and then, after 4 s, says this (`fixed`); none: it stays `fixing`. */
  stepFixed?: LookResearch;
  /** The box's network and the Wi-Fi around it (CG-110): the chip and the sheet; none: no chip, as before. */
  wifi?: WifiWorld;
  /** The Wi-Fi sheet at the start (open, on which step, what is typed). */
  wifiSheet?: WifiInitial;
  /** The box's Bluetooth and the devices around it (CG-211): the chip and the sheet; none: no chip, as before. */
  bluetooth?: BluetoothWorld;
  /** The Bluetooth sheet at the start (open, on which step). */
  bluetoothSheet?: BluetoothInitial;
  /** The remote help sheet at the start (CG-296). */
  remoteHelpSheet?: RemoteHelpInitial;
  /** Every server the demo desk sends (`/api/desk/servers`, DK-86); none: 404, as a runtime before 0.115. */
  servers?: DeskServersAnswer;
  /** A server's own screen (`/api/desk/server`, DK-83) by id and range; null: 404 `not_found`. */
  serverPage?: (id: string, range: ServerRange) => Omit<DeskServerPage, 'now'> | null;
  /** The hosts service doesn't answer from this time on (ms): both answer 503 `unavailable`. */
  hostsAwayAfter?: number;
  /** The box's outputs as the kiosk would name them (`#o=`): a monitor beside the box's own display (DK-147). */
  outputs?: KioskOutput[];
  note: string;
}

const GiB = 1024 ** 3;
const NOW = '2026-09-27T12:00:00Z';

/** A disk that held Windows: its name is typed to confirm. */
const disks: Disk[] = [
  {
    path: '/dev/sda',
    name: 'sda',
    model: 'QEMU HARDDISK',
    sizeBytes: 128 * GiB,
    eligible: true,
    reason: '',
    empty: false,
    parts: [
      { label: '', fsType: 'vfat', sizeBytes: 100 * 1024 ** 2 },
      { label: '', fsType: '', sizeBytes: 16 * 1024 ** 2 },
      { label: 'OS', fsType: 'ntfs', sizeBytes: 127 * GiB },
    ],
  },
];
/** A new disk with nothing on it: a button confirms. */
const emptyDisks: Disk[] = [{ ...(disks[0] as Disk), empty: true, parts: [] }];
const manyDisks: Disk[] = [
  {
    path: '/dev/nvme0n1',
    name: 'nvme0n1',
    model: 'Samsung SSD 990 PRO 1TB',
    sizeBytes: 1000204886016,
    eligible: true,
    reason: '',
  },
  {
    path: '/dev/sda',
    name: 'sda',
    model: 'WD Red Plus 4TB',
    sizeBytes: 4000787030016,
    eligible: true,
    reason: '',
  },
  {
    path: '/dev/sdb',
    name: 'sdb',
    model: 'SanDisk Ultra Fit',
    sizeBytes: 32 * GiB,
    eligible: false,
    reason: 'installer-medium',
  },
  {
    path: '/dev/sdc',
    name: 'sdc',
    model: 'Expansion HDD',
    sizeBytes: 2000398934016,
    eligible: false,
    reason: 'usb',
  },
  {
    path: '/dev/mmcblk0',
    name: 'mmcblk0',
    model: '',
    sizeBytes: 64 * GiB,
    eligible: false,
    reason: 'too-small',
  },
];

const okChecks: Check[] = [
  { id: 'uefi', status: 'ok', value: 'UEFI' },
  { id: 'cpu', status: 'ok', value: '4 cores' },
  { id: 'memory', status: 'ok', value: '8 GiB' },
  { id: 'disk', status: 'ok', value: 'sda · 128 GiB' },
  { id: 'network', status: 'ok', value: '192.168.1.23' },
  { id: 'reach-api', status: 'ok', value: 'api.whombat.com' },
  { id: 'reach-updates', status: 'ok', value: 'updates.whombat.com' },
  { id: 'reach-relay', status: 'ok', value: 'relay.whombat.com' },
];

const withChecks = (patch: Partial<Record<Check['id'], Partial<Check>>>): Check[] =>
  okChecks.map((c) => ({ ...c, ...(patch[c.id] ?? {}) }));

const log = [
  '== installing Whombat on /dev/sda',
  '== partitioning /dev/sda',
  'sfdisk: created a new GPT disklabel',
  '/dev/sda1: 1 GiB EFI System',
  '/dev/sda2: 24 GiB Linux root (x86-64)',
  '/dev/sda3: 103 GiB Linux filesystem (persist)',
  '== creating file systems',
  'mkfs.fat 4.2 (2021-01-31)',
  'mkfs.ext4: /dev/sda2 done',
  'mkfs.ext4: /dev/sda3 done',
  '== copying the system',
  'copying path /nix/store/…-whombat-appliance-system (1 of 1,412)',
  'copying path /nix/store/…-linux-6.12.48 (212 of 1,412)',
  'copying path /nix/store/…-postgresql-17.6 (498 of 1,412)',
  'copying path /nix/store/…-whombat-runtime-0.15.3 (641 of 1,412)',
];

type InstallerPatch = Omit<Partial<InstallerState>, 'install'> & {
  install?: Partial<InstallerState['install']>;
};

function installer(p: InstallerPatch = {}): InstallerState {
  const base: InstallerState = {
    mode: 'installer',
    platform: 'self-installed',
    storage: 'host-encrypted',
    environment: 'dev',
    release: 'whombat-20261021.1',
    appUrl: 'dev.whombat.com',
    preflight: { status: 'done', checks: okChecks, disks },
    install: { status: 'idle', disk: null, step: null, percent: 0, log: [], error: '' },
  };
  return { ...base, ...p, install: { ...base.install, ...(p.install ?? {}) } } as InstallerState;
}

/** The production ISO on a dedicated machine (CG-30: the same ISO and platform id as on Proxmox). */
const prod = {
  environment: 'prod',
  release: 'whombat-20261021.2',
  appUrl: 'app.whombat.com',
} as const;

function consoleState(p: Partial<ConsoleState>): ConsoleState {
  return {
    mode: 'console',
    now: NOW,
    claim: null,
    desk: null,
    footer:
      'Whombat appliance. There is no login on this console.\nFor local recovery, restart and hold Space to open the boot menu, then choose\n"Whombat Recovery".',
    ...p,
  };
}

const claimBase = {
  code: '',
  claimUrl: 'app.whombat.com/claim',
  appUrl: 'app.whombat.com',
  retryAt: null,
  burrows: null,
};
/** A claim state; a claimable one with a claim link and its code gets that link's QR code, as the server sends it. */
const claim = (
  p: Partial<NonNullable<ConsoleState['claim']>> & { state: NonNullable<ConsoleState['claim']>['state'] },
) => {
  const c = { ...claimBase, ...p };
  const qr = c.state === 'claimable' && c.claimUrl && c.code ? demoQr(`https://${c.claimUrl}`) : [];
  return consoleState({ claim: { ...c, ...(qr.length && !p.qr ? { qr } : {}) } });
};

const one = (state: ServerState) => [{ at: 0, state }];

/** A claim state with Whombat Link and Tailscale as the server sends them (CG-404). */
const claimReach = (
  p: Partial<NonNullable<ConsoleState['claim']>> & { state: NonNullable<ConsoleState['claim']>['state'] },
  reach: ConsoleReach,
) => ({ ...claim(p), reach });
const linkBase: ReachLink = {
  state: 'starting',
  code: '',
  url: '',
  qr: [],
  expiresAt: null,
  waitingForAddress: false,
  graceEndsOn: '',
};
/** The Link code changes 12½ min after the fixture's clock. */
const linkCode: ReachLink = {
  ...linkBase,
  code: 'KXQM-TRVW',
  url: 'app.whombat.com/link',
  qr: demoQr('https://app.whombat.com/link?code=KXQM-TRVW'),
  expiresAt: '2026-09-27T12:12:30Z',
};
/** Tailscale's sign-in, as the server sends it with its QR code; `first` when the claim under it is the second step. */
const tailscaleLogin = (first: boolean) => ({
  loginUrl: 'login.tailscale.com/a/1a2b3c4d5e6f7a',
  needsHttps: false,
  loginQr: demoQr('https://login.tailscale.com/a/1a2b3c4d5e6f7a'),
  first,
});

/** A device waiting to sign in at the screen (BX-06), its code going away `minutes` after the fixture's clock. */
const signIn = (minutes: number, p: Partial<SignIn> = {}): SignIn => ({
  code: 'KXQMTR',
  name: 'John Doe',
  device: 'Pixel 9',
  expiresAt: new Date(Date.parse(NOW) + minutes * 60_000).toISOString(),
  ...p,
});

export const FIXTURES: Record<string, Fixture> = {
  // Installer
  'installer-welcome': { note: 'Welcome (dev)', timeline: one(installer()) },
  'installer-welcome-prod': {
    note: 'Welcome (prod)',
    timeline: one(installer(prod)),
  },
  'installer-reach': {
    note: 'How you’ll reach it: Whombat Link chosen',
    wizard: { step: 'reach' },
    timeline: one(installer(prod)),
  },
  'installer-reach-tailscale': {
    note: 'How you’ll reach it: Tailscale with a login server that isn’t an https address',
    wizard: { step: 'reach', reach: 'tailscale', loginServer: 'headscale.example.com' },
    timeline: one(installer(prod)),
  },
  'installer-checks-running': {
    note: 'Checks running',
    wizard: { step: 'checks' },
    timeline: one(
      installer({
        preflight: {
          status: 'running',
          checks: withChecks({
            network: { status: 'running', value: '' },
            'reach-api': { status: 'running', value: 'api.whombat.com' },
            'reach-updates': { status: 'running', value: 'updates.whombat.com' },
            'reach-relay': { status: 'running', value: 'relay.whombat.com' },
          }),
          disks,
        },
      }),
    ),
  },
  'installer-checks-ok': { note: 'Checks all ok', wizard: { step: 'checks' }, timeline: one(installer()) },
  'installer-checks-ok-details': {
    note: 'Checks all ok, Details open',
    wizard: { step: 'checks' },
    timeline: one(installer()),
  },
  'installer-checks-warn': {
    note: 'Checks with warnings',
    wizard: { step: 'checks' },
    timeline: one(
      installer({
        preflight: {
          status: 'done',
          checks: withChecks({
            cpu: { status: 'warn', value: '2 cores' },
            memory: { status: 'warn', value: '6 GiB' },
            'reach-relay': { status: 'warn', value: 'relay.whombat.com' },
          }),
          disks,
        },
      }),
    ),
  },
  'installer-checks-fail': {
    note: 'Checks with failures',
    wizard: { step: 'checks' },
    timeline: one(
      installer({
        preflight: {
          status: 'done',
          checks: withChecks({
            uefi: { status: 'fail', value: 'BIOS' },
            memory: { status: 'fail', value: '2 GiB' },
            disk: { status: 'fail', value: '' },
            network: { status: 'warn', value: 'no address' },
            'reach-api': { status: 'warn', value: 'api.whombat.com' },
          }),
          disks: [{ ...(disks[0] as Disk), sizeBytes: 64 * GiB, eligible: false, reason: 'too-small' }],
        },
      }),
    ),
  },
  'installer-checks-disk-refused': {
    note: 'Checks: no disk to install on, each one’s reason',
    wizard: { step: 'checks' },
    timeline: one(
      installer({
        ...prod,
        preflight: {
          status: 'done',
          checks: withChecks({ disk: { status: 'fail', value: '' } }),
          disks: manyDisks.map((d) =>
            d.eligible ? { ...d, eligible: false, reason: 'in-use' as const } : d,
          ),
        },
      }),
    ),
  },
  'installer-checks-disk-small': {
    note: 'Checks: the only disk is too small (a VM’s default disk)',
    wizard: { step: 'checks' },
    timeline: one(
      installer({
        ...prod,
        preflight: {
          status: 'done',
          checks: withChecks({ disk: { status: 'fail', value: '' } }),
          disks: [{ ...(disks[0] as Disk), sizeBytes: 10 * GiB, eligible: false, reason: 'too-small' }],
        },
      }),
    ),
  },
  'installer-disk': {
    note: 'Choose a disk (two eligible, a USB drive, a small eMMC)',
    wizard: { step: 'disk' },
    timeline: one(installer({ ...prod, preflight: { status: 'done', checks: okChecks, disks: manyDisks } })),
  },
  'installer-erase': {
    note: 'Erase and install, nothing typed',
    wizard: { step: 'erase' },
    timeline: one(installer()),
  },
  'installer-erase-empty': {
    note: 'Erase and install on an empty disk: a button, no typing',
    wizard: { step: 'erase' },
    timeline: one(installer({ preflight: { status: 'done', checks: okChecks, disks: emptyDisks } })),
  },
  'installer-erase-empty-refused': {
    note: 'Erase and install on an empty disk, Enter pressed, the server refused',
    wizard: { step: 'erase' },
    post: { '/api/install': 400 },
    timeline: one(installer({ preflight: { status: 'done', checks: okChecks, disks: emptyDisks } })),
  },
  'installer-erase-typed': {
    note: 'Erase and install, “sda” typed',
    wizard: { step: 'erase' },
    timeline: one(installer()),
  },
  'installer-erase-refused': {
    note: 'Erase and install, the server refused',
    wizard: { step: 'erase' },
    post: { '/api/install': 400 },
    timeline: one(installer()),
  },
  'installer-installing': {
    note: 'Installing, copying 46 %',
    timeline: one(
      installer({ install: { status: 'running', disk: '/dev/sda', step: 'copy', percent: 46, log } }),
    ),
  },
  'installer-installing-details': {
    note: 'Installing, details shown',
    timeline: one(
      installer({ install: { status: 'running', disk: '/dev/sda', step: 'copy', percent: 46, log } }),
    ),
  },
  'installer-done': {
    note: 'Done',
    timeline: one(
      installer({
        install: {
          status: 'done',
          disk: '/dev/sda',
          step: 'finish',
          percent: 100,
          log: [...log, '== done: remove the installer medium and restart'],
        },
      }),
    ),
  },
  'installer-failed': {
    note: 'Failed while copying',
    timeline: one(
      installer({
        install: {
          status: 'failed',
          disk: '/dev/sda',
          step: 'copy',
          percent: 38,
          log: [
            ...log,
            'error: writing to /mnt/nix/store: No space left on device',
            'whombat-install: failed',
          ],
          error: 'No space left on device',
        },
      }),
    ),
  },
  'installer-live': {
    note: 'The whole install, live (about 40 s)',
    timeline: [
      {
        at: 0,
        state: installer({
          preflight: {
            status: 'running',
            checks: withChecks({ network: { status: 'running', value: '' } }),
            disks,
          },
        }),
      },
      { at: 4000, state: installer() },
      ...[0, 8, 20, 35, 50, 62, 74, 86, 94, 98].map((percent, i) => ({
        at: 20000 + i * 2000,
        state: installer({
          install: {
            status: 'running' as const,
            disk: '/dev/sda',
            step:
              (
                [
                  'partition',
                  'filesystems',
                  'copy',
                  'copy',
                  'copy',
                  'copy',
                  'copy',
                  'boot',
                  'finish',
                  'finish',
                ] as const
              )[i] ?? 'finish',
            percent,
            log: log.slice(0, 2 + i),
          },
        }),
      })),
      {
        at: 40000,
        state: installer({
          install: { status: 'done', disk: '/dev/sda', step: 'finish', percent: 100, log },
        }),
      },
    ],
  },

  // Console
  'console-starting': { note: 'Starting', timeline: one(claim({ state: 'starting' })) },
  'console-start-release-missing': {
    note: 'The first start can’t finish: no update channel lists its release (CG-409)',
    timeline: one(
      claim({ state: 'starting', start: { problem: 'release-missing', release: 'whombat-20261120.15' } }),
    ),
  },
  'console-start-offline': {
    note: 'The first start can’t finish: the update server is out of reach (CG-409)',
    timeline: one(claim({ state: 'starting', start: { problem: 'offline', release: '' } })),
  },
  'console-waiting': { note: 'Connecting', timeline: one(claim({ state: 'waiting' })) },
  'console-claimable': { note: 'Claim code', timeline: one(claim({ state: 'claimable', code: 'KXQM' })) },
  'console-claimable-wide': {
    note: 'Claim code, widest letters',
    timeline: one(claim({ state: 'claimable', code: 'WMWM' })),
  },
  'console-claimable-no-address': {
    note: 'Claimable, no address at all (a name over plain HTTP): no code',
    timeline: one(claim({ state: 'claimable', claimUrl: '', appUrl: '' })),
  },
  'console-claimable-in-app': {
    note: 'Claimable, no secure address: the code for the app on this network',
    timeline: one(
      claim({ state: 'claimable', code: 'KXQM', claimUrl: '', appUrl: '', inApp: '192.168.1.20' }),
    ),
  },
  'console-claimable-new-letters': {
    note: 'Claimable in the app, New letters offered',
    timeline: one(
      claim({
        state: 'claimable',
        code: 'KXQM',
        claimUrl: '',
        appUrl: '',
        inApp: '192.168.1.20',
        newLetters: true,
      }),
    ),
  },
  'console-claimable-letters-stay': {
    note: 'New letters were asked for: they stay for ten minutes',
    timeline: one(
      claim({
        state: 'claimable',
        code: 'PRTV',
        claimUrl: '',
        appUrl: '',
        inApp: '192.168.1.20',
        newLetters: true,
        lettersUntil: '2026-09-27T12:10:00Z',
      }),
    ),
  },
  'console-claimable-own-address': {
    note: 'Claim link at the box’s own address, with its address on this network as the other way in',
    timeline: one(
      claim({
        state: 'claimable',
        code: 'KXQM',
        claimUrl: 'quiet-river-otter.box.whombat.app/c/kxqmtv',
        appUrl: 'quiet-river-otter.box.whombat.app',
        fallbackInApp: '192.168.1.20',
        newLetters: true,
      }),
    ),
  },
  'console-claimable-own-address-tailnet': {
    note: 'Claim link at the box’s own address, with its Tailscale page as the other way in',
    timeline: one(
      claim({
        state: 'claimable',
        code: 'KXQM',
        claimUrl: 'quiet-river-otter.box.whombat.app/c/kxqmtv',
        appUrl: 'quiet-river-otter.box.whombat.app',
        fallbackTailnet: 'whombat.tail1234.ts.net:4480',
        newLetters: true,
      }),
    ),
  },
  'console-claimable-ipv6-only': {
    note: 'Claimable, only an IPv6 address on this network: no code, an IPv4 address is another way',
    timeline: one(claim({ state: 'claimable', claimUrl: '', appUrl: '', ipv6Only: true })),
  },
  'console-waiting-ipv6-only': {
    note: 'Waiting on a network with IPv6 only and no address to name: the same screen, not “check the cable”',
    timeline: one(claim({ state: 'waiting', claimUrl: '', appUrl: '', ipv6Only: true })),
  },
  'console-backoff': {
    note: 'Too many wrong codes',
    timeline: one(claim({ state: 'backoff', retryAt: '2026-09-27T12:04:30Z' })),
  },
  'console-backoff-new-letters': {
    note: 'Too many wrong codes, New letters offered',
    timeline: one(
      claim({
        state: 'backoff',
        claimUrl: '',
        appUrl: '',
        retryAt: '2026-09-27T12:04:30Z',
        newLetters: true,
      }),
    ),
  },
  'console-claimed': {
    note: 'Claimed, three burrows',
    timeline: one(claim({ state: 'claimed', burrows: { first: 'Banjo’s Burrow', more: 2 } })),
  },
  'console-claimed-one-more': {
    note: 'Claimed, two burrows',
    timeline: one(claim({ state: 'claimed', burrows: { first: 'Harbour Street Studio', more: 1 } })),
  },
  'console-claimed-single': {
    note: 'Claimed, one burrow',
    timeline: one(claim({ state: 'claimed', burrows: { first: 'Acme', more: 0 } })),
  },
  'console-claimed-long': {
    note: 'Claimed, a very long burrow name',
    timeline: one(
      claim({
        state: 'claimed',
        burrows: { first: 'The Extremely Long Name of the Northern Hairy-nosed Research Burrow', more: 12 },
      }),
    ),
  },
  'console-claimed-noname': {
    note: 'Claimed, no burrow name yet',
    timeline: one(claim({ state: 'claimed' })),
  },
  'console-claimed-no-address': {
    note: 'Claimed, no secure address (Link ended): the apps on this network',
    timeline: one(
      claim({ state: 'claimed', claimUrl: '', appUrl: '', burrows: { first: 'Banjo’s Burrow', more: 2 } }),
    ),
  },
  // Whombat Link and Tailscale (CG-404): the text console's screens on the page.
  'console-link-code': {
    note: 'Whombat Link starting: its code in place of the claim',
    timeline: one(claimReach({ state: 'claimable', code: 'KXQM' }, { link: linkCode })),
  },
  'console-link-waiting': {
    note: 'Whombat Link confirmed, waiting for an address',
    timeline: one(
      claimReach({ state: 'claimable', code: 'KXQM' }, { link: { ...linkBase, waitingForAddress: true } }),
    ),
  },
  'console-link-on-waiting': {
    note: 'Easy: Whombat Link on, the web address still coming; the app on this network claims it already',
    timeline: one(
      claimReach(
        {
          state: 'claimable',
          code: 'EQMX',
          claimUrl: '',
          appUrl: '',
          inApp: '10.100.0.10',
          newLetters: true,
        },
        { link: { ...linkBase, state: 'on', waitingForAddress: true } },
      ),
    ),
  },
  'console-link-starting': {
    note: 'Whombat Link starting, no code yet',
    timeline: one(claimReach({ state: 'claimable', code: 'KXQM' }, { link: linkBase })),
  },
  'console-tailscale': {
    note: 'Tailscale: sign in, then turn on HTTPS (no secure address yet)',
    timeline: one(
      claimReach(
        { state: 'claimable', claimUrl: '', appUrl: '', second: true },
        { tailscale: { ...tailscaleLogin(true), needsHttps: true } },
      ),
    ),
  },
  'console-tailscale-first': {
    note: 'Expert: 1 · sign in to Tailscale, 2 · claim in the app on this network, which works right away',
    timeline: one(
      claimReach(
        {
          state: 'claimable',
          code: 'WADA',
          claimUrl: '',
          appUrl: '',
          inApp: '10.100.0.214',
          newLetters: true,
          second: true,
        },
        { tailscale: tailscaleLogin(true) },
      ),
    ),
  },
  'console-tailscale-claim': {
    note: 'Tailscale: the claim on the box’s tailnet name',
    timeline: one(
      claim({ state: 'claimable', code: 'KXQM', claimUrl: 'whombat.tail1234.ts.net/claim', onTailnet: true }),
    ),
  },
  'console-link-code-notes': {
    note: 'The most a screen holds: Tailscale’s long sign-in link and HTTPS over the Link code',
    timeline: one(
      claimReach(
        { state: 'claimable', code: 'KXQM' },
        {
          link: linkCode,
          // Too long for a QR code a phone reads off the screen: the words only.
          tailscale: {
            loginUrl: `login.tailscale.com/a/${'1a2b3c4d5e6f7a8b'.repeat(8)}`,
            needsHttps: true,
            loginQr: [],
            first: false,
          },
        },
      ),
    ),
  },
  'console-link-grace': {
    note: 'Whombat Link in grace: when it ends, over the claimed screen',
    timeline: one(
      claimReach(
        { state: 'claimed', burrows: { first: 'Banjo’s Burrow', more: 2 } },
        { link: { ...linkBase, state: 'grace', graceEndsOn: '25 November' } },
      ),
    ),
  },
  'console-link-ended': {
    note: 'Whombat Link ended: no secure address, how to come back',
    timeline: one(
      claimReach(
        { state: 'claimed', claimUrl: '', appUrl: '', burrows: { first: 'Banjo’s Burrow', more: 2 } },
        { link: { ...linkBase, state: 'ended' } },
      ),
    ),
  },
  'console-celebrate': {
    note: 'The claim happens while watching',
    timeline: [
      { at: 0, state: claim({ state: 'claimable', code: 'KXQM' }) },
      { at: 1500, state: claim({ state: 'claimed', burrows: { first: 'Banjo’s Burrow', more: 2 } }) },
    ],
  },
  'console-dimmed': {
    note: 'Claim code after 10 min without a key (burn-in)',
    idleMs: 13 * 60_000,
    timeline: one(claim({ state: 'claimable', code: 'KXQM' })),
  },
  'console-away': {
    note: 'The console server is away for more than 10 s',
    awayAfter: 1500,
    timeline: one(claim({ state: 'claimable', code: 'KXQM' })),
  },
  connecting: { note: 'No state yet (server not answering)', awayAfter: 0, timeline: [] },

  // A device waiting to sign in at the screen (BX-06, CG-150)
  'console-signin': {
    note: 'A device asks to sign in: the panel over the claimed screen, 4½ minutes left',
    timeline: one(
      claim({ state: 'claimed', burrows: { first: 'Banjo’s Burrow', more: 2 }, signIn: signIn(4.5) }),
    ),
  },
  'console-signin-last': {
    note: 'The panel under a minute before its code goes away: “in 1 min”',
    timeline: one(
      claim({ state: 'claimed', burrows: { first: 'Banjo’s Burrow', more: 2 }, signIn: signIn(0.6) }),
    ),
  },
  'console-signin-long': {
    note: 'The panel with the longest name and device label (64 code points each)',
    timeline: one(
      claim({
        state: 'claimed',
        burrows: { first: 'Banjo’s Burrow', more: 2 },
        signIn: signIn(4.5, {
          name: 'johanna.wilhelmina.van-der-berg-angstrom@harbour-street-studio.example',
          device: 'Firefox on the ThinkPad X1 Carbon in the back office, second desk',
        }),
      }),
    ),
  },
  'console-signin-dimmed': {
    note: 'The panel on a claimed screen nobody touched for 13 minutes: it wakes it, no dim',
    idleMs: 13 * 60_000,
    timeline: one(
      claim({ state: 'claimed', burrows: { first: 'Banjo’s Burrow', more: 2 }, signIn: signIn(4.5) }),
    ),
  },
  'console-signin-gone': {
    note: 'The panel on a screen untouched for 13 minutes, then the code used: the claimed screen, still awake',
    idleMs: 13 * 60_000,
    timeline: [
      {
        at: 0,
        state: claim({
          state: 'claimed',
          burrows: { first: 'Banjo’s Burrow', more: 2 },
          signIn: signIn(4.5),
        }),
      },
      { at: 1500, state: claim({ state: 'claimed', burrows: { first: 'Banjo’s Burrow', more: 2 } }) },
    ],
  },

  // The desk display (CG-37…)
  ...DESK_FIXTURES,
  ...CALM_FIXTURES,
  ...SCREEN_FIXTURES,

  // The network chip, the Wi-Fi sheet and the installer's Wi-Fi step (CG-100…)
  ...WIFI_FIXTURES,
  ...BLUETOOTH_FIXTURES,
  // Remote help's line (CG-290…CG-292)
  ...REMOTE_HELP_FIXTURES,
};
