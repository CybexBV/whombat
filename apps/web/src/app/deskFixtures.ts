/**
 * The desk screen in fixture mode and the fake managed world (desk-display-web.md AP-3012, AP-3110): a box with its own
 * screen (a ROG Flow Z13 on Mara's desk), from `@whombat/client/desk/fake`. `VITE_FIXTURE_DESK` (option `desk`, the
 * fake world's `desk` fault, or `localStorage['whombat:fixture-desk']` for the visual suite) picks the world. A runtime
 * before the switch (0.100): `unpaired`; `paired` (with Mara, since two days); `request` (paired, and the screen asks Mara to unlock); `nomic` (paired with Mara on a box without
 * a microphone). A runtime with the switch (0.101, DK-16…DK-20): `auto` (the Z13's own panel paired itself with Mara,
 * no PIN yet); `pinned` (the same with her PIN and choices); `monitor` (a DELL U2720Q paired with Mara, When you leave
 * and the camera on); `off` (the DELL, turned off); `vm` (a virtual machine's QEMU screen, off as nobody chose); `unplugged`
 * (paired with Mara, no screen connected now). The Z13 has a camera the presence service reads (0.103, DK-28) and
 * speaks with the six voices (0.105, DK-50; AP-3405): Mara's rows have Voice under Talk, Heart chosen, and Listen plays
 * the fake's tones. `auto`, `pinned` and `monitor` are 0.107 runtimes (DK-72, DK-74; AP-3602): *Lock again* (After 2
 * minutes · When you leave · When you press Lock) and *Use the camera to see when you’re here*, off on the Z13, When you
 * leave and on on the DELL; `presence` is the Z13 with Mara's PIN on a runtime before 0.107 (*Stay unlocked while you’re
 * here*); `nocamera` the DELL paired with Mara on a 0.107 runtime without a camera (Lock again without When you leave,
 * no camera switch); the others are runtimes from before the camera. `screens` is a 3.6 runtime (screens of widgets,
 * desk-display-web.md AP-5940…): `pinned`'s Z13 with the mockups' three screens — its own with *Overview*, *Media* and
 * *House*, an office monitor and a kitchen tablet — so Settings shows *Screens* and the editor. Without one, fixture mode has no desk and the fake world's boxes are VMs
 * without a display, so This Whombat stays as the mocks draw it. In development the screen's side is
 * `window.__WHOMBAT_DESK__`: `letters()` while pairing, `requestUnlock()` (the fake world:
 * `__WHOMBAT_FAKE__.deskLetters(device)` and `deskRequestUnlock(device)`).
 */
import type { DeskApi, DeskDisplay } from '@whombat/client/desk';
import { DEFAULT_DESK_SETTINGS, DESK_VOICES } from '@whombat/client/desk';
import {
  createFakeDesk,
  type FakeDesk,
  type FakeDeskOptions,
  type FakeDeskPerson,
  type FakeDeskSnapshot,
  fakeDeskApi,
} from '@whombat/client/desk/fake';
import { mara } from '@whombat/fixtures';

const KINDS = [
  'unpaired',
  'paired',
  'request',
  'nomic',
  'auto',
  'pinned',
  'monitor',
  'off',
  'vm',
  'unplugged',
  'presence',
  'nocamera',
  'screens',
] as const;
export type DeskFixtureKind = (typeof KINDS)[number];

/** Where the visual suite picks a screen before the page loads (fixture mode only). */
export const DESK_FIXTURE_KEY = 'whombat:fixture-desk';

const known = (v: unknown): v is DeskFixtureKind => (KINDS as readonly unknown[]).includes(v);

/** The world from `desk`, else `VITE_FIXTURE_DESK`, else the page's storage; null: no desk. */
export function deskFixtureKind(option?: DeskFixtureKind | false | null): DeskFixtureKind | null {
  if (option === false) return null;
  if (option) return option;
  const env = import.meta.env.VITE_FIXTURE_DESK;
  if (known(env)) return env;
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(DESK_FIXTURE_KEY);
  return known(stored) ? stored : null;
}

/** A laptop on a desk has a battery; a virtual machine doesn't (the power line, AP-3021). */
export function deskFixtureHasBattery(kind: DeskFixtureKind | null): boolean {
  return kind !== null && kind !== 'vm';
}

export const DESK_FIXTURE_VIEWER: FakeDeskPerson = { personId: mara.id, name: mara.name };

const DAY = 86_400_000;

/** A box without a screen (a VM): `desk.get` answers, This Whombat shows no SCREEN. */
const NO_SCREEN: FakeDeskOptions['hardware'] = {
  hasDisplay: false,
  hasMicrophone: false,
  hasSpeaker: false,
  hasBattery: false,
  voiceAvailable: false,
};

/** The screens a 0.101 runtime reads (DK-16): the Z13's own panel, a monitor, a VM's, none. */
const PANEL: DeskDisplay = { connected: true, real: true, builtIn: true, name: null };
const DELL: DeskDisplay = { connected: true, real: true, builtIn: false, name: 'DELL U2720Q' };
const QEMU: DeskDisplay = { connected: true, real: false, builtIn: false, name: 'QEMU Monitor' };
const NONE: DeskDisplay = { connected: false, real: false, builtIn: false, name: null };

const DISPLAYS: Partial<Record<DeskFixtureKind, DeskDisplay>> = {
  auto: PANEL,
  pinned: PANEL,
  monitor: DELL,
  off: DELL,
  vm: QEMU,
  unplugged: NONE,
  presence: PANEL,
  nocamera: DELL,
  screens: PANEL,
};

/** Worlds whose box has a camera the presence service reads (0.103, DK-28) and speaks with the six voices (0.105). */
const CAMERA: readonly DeskFixtureKind[] = ['auto', 'pinned', 'monitor', 'presence', 'screens'];

/** The fake screen's machine, what the runtime reads of the screen, and its pairing for a world (null: a VM). */
export function deskSeed(
  kind: DeskFixtureKind | null,
  now: number,
): Pick<FakeDeskOptions, 'hardware' | 'display' | 'screens'> & { initial: FakeDeskSnapshot | null } {
  if (!kind) return { hardware: NO_SCREEN, initial: null };
  // Screens of widgets (3.6): the Z13 with Mara's PIN, an office monitor and a kitchen tablet.
  if (kind === 'screens') return { ...deskSeed('pinned', now), screens: true };
  const display = DISPLAYS[kind];
  const hardware: FakeDeskOptions['hardware'] =
    kind === 'nomic'
      ? { hasMicrophone: false }
      : kind === 'vm'
        ? { ...NO_SCREEN, hasDisplay: true }
        : CAMERA.includes(kind)
          ? { presenceAvailable: true, voices: [...DESK_VOICES] }
          : kind === 'nocamera'
            ? { voices: [...DESK_VOICES] }
            : {};
  const person = mara;
  // Nobody paired; turned off; a VM's screen nobody chose for.
  if (kind === 'unpaired' || kind === 'off' || kind === 'vm')
    return {
      hardware,
      ...(display ? { display } : {}),
      initial: kind === 'off' ? { paired: null, settings: DEFAULT_DESK_SETTINGS, on: false } : null,
    };
  const self = kind === 'auto';
  return {
    hardware,
    ...(display ? { display } : {}),
    initial: {
      paired: {
        personId: person.id,
        name: person.name,
        // It paired itself this morning (DK-17); the others two days ago.
        pairedAt: new Date(now - (self ? 3 * 3_600_000 : 2 * DAY)).toISOString(),
        pin: self ? null : '246810',
        ...(display ? { self } : {}),
      },
      settings: self
        ? DEFAULT_DESK_SETTINGS
        : {
            lockedView: 'summary',
            quietHours: { enabled: true, start: '23:00', end: '07:00' },
            night: 'dim',
            voice: kind !== 'nomic',
            // The DELL's: When you leave, and the camera for the clock (DK-72, DK-74).
            presence: kind === 'monitor',
            speechVoice: 'heart',
            stayUnlocked: false,
            cameraWake: kind === 'monitor',
            show: DEFAULT_DESK_SETTINGS.show,
          },
      ...(display ? { on: self ? null : true } : {}),
    },
  };
}

/** The page's own screen (`VITE_FIXTURE_DESK`): one per page, however often its services are made (StrictMode). */
let pageDesk: { kind: DeskFixtureKind; value: { desk: FakeDesk; api: DeskApi } } | null = null;

/**
 * The fixture world's screen and Mara's `DeskApi` on it; null without a desk. The world `VITE_FIXTURE_DESK` names is the
 * page's one screen; one an option names (tests, stories) is new each time.
 */
export function deskFixture(option?: DeskFixtureKind | false): { desk: FakeDesk; api: DeskApi } | null {
  const kind = deskFixtureKind(option);
  if (!kind) return null;
  if (option === undefined) {
    if (pageDesk?.kind !== kind) pageDesk = { kind, value: newDesk(kind) };
    return pageDesk.value;
  }
  return newDesk(kind);
}

function newDesk(kind: DeskFixtureKind): { desk: FakeDesk; api: DeskApi } {
  const desk = createFakeDesk(deskSeed(kind, Date.now()));
  if (kind === 'request') desk.requestUnlock();
  if (import.meta.env.DEV && typeof window !== 'undefined')
    (window as unknown as { __WHOMBAT_DESK__?: FakeDesk }).__WHOMBAT_DESK__ = desk;
  return { desk, api: fakeDeskApi(desk, DESK_FIXTURE_VIEWER) };
}
