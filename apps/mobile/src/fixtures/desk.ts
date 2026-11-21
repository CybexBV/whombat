/**
 * The desk display in the demo world (desk-display-android.md AP-3061, AP-3125): the web's fake screen
 * (`createFakeDesk`, `@whombat/client/desk/fake`) answering `desk.*` for the demo's person, on a box plugged in with its
 * battery kept at 80 %. It starts as a new box does (DK-17): its own panel paired itself with the demo's person, no PIN
 * yet (`auto`). From `unpaired`, Pair the screen “shows” the
 * fake's letters in turn (KXQM first, then TRAW…; the demo has no screen to read them from), five wrong tries draw the
 * next ones. Paired, the screen asks to unlock once a few seconds later, as if someone at it pressed “Confirm on your
 * phone” (two minutes, then it runs out).
 *
 * The box's panel has a camera (DK-28) and speaks with the six voices (DK-50; AP-3427): `auto` and `pinned` have Voice
 * under Talk, Heart chosen, and Listen plays the fake's tones. `auto` and `pinned` have *Lock again* (After 2 minutes ·
 * When you leave · When you press Lock; DK-72, DK-74, AP-3627) and *Use the camera to see when you’re here*, off;
 * `nocamera` is the DELL paired with you without a camera (Lock again without When you leave, no camera switch).
 *
 * Paired, it has the mockups' world behind Settings → Screen (the fake's eight servers and connections): its lists and
 * its preview are the box's own planner's (AP-5869).
 *
 * It answers `desk.screens` (screens of widgets, 3.6; desk-display-android.md AP-6030): the box's own screen with
 * *Overview*, *Media* and *House*, an office monitor and a kitchen tablet, and a tablet waiting to be added with its
 * six letters (`waitingLetters`: KTRMWP first; another waits once it's added). `older` is a runtime before 3.6 (the
 * older *Screen* page).
 *
 * Settings → This Whombat and Settings → Screen take `?desk=<state>` in the demo world
 * (`whombat://settings/whombat?desk=battery`, `whombat://settings/screen?desk=pinned&part=shows`) to start over in
 * another state, for checks on the emulator: `DESK_DEMO_STATES`. Pure TypeScript.
 */
import {
  DEFAULT_DESK_SETTINGS,
  DESK_VOICES,
  type DeskApi,
  type DeskDisplay,
  type HostPower,
} from '@whombat/client/desk';
import {
  createFakeDesk,
  type FakeDesk,
  type FakeDeskOptions,
  type FakeDeskPerson,
  fakeDeskApi,
} from '@whombat/client/desk/fake';

export const DESK_DEMO_STATES = [
  /** The box's own panel paired itself with you; no PIN yet (the start). */
  'auto',
  /** The same with your PIN. */
  'pinned',
  /** A DELL U2720Q, turned off. */
  'off',
  /** A virtual machine's screen nobody turned on: off, with why. */
  'vm',
  /** Paired with you; no screen connected now. */
  'unplugged',
  /** The DELL with your PIN and no camera: Lock again without When you leave. */
  'nocamera',
  /** Nobody paired it; the box has a screen. */
  'unpaired',
  /** Its letters are on the screen now. */
  'pairing',
  /** Paired with you, the defaults. */
  'paired',
  /** Paired, and the screen asks to unlock. */
  'unlock',
  /** Paired; the machine has no microphone, so Talk can't be on. */
  'no-mic',
  /** Paired; speech isn't working on the box. */
  'no-voice',
  /** A box without a screen (a VM): no SCREEN card. */
  'none',
  /** Paired; the power is out. */
  'battery',
  /** Paired; plugged in and charging. */
  'charging',
  /** Paired with your PIN on a runtime before screens of widgets: the older Screen page. */
  'older',
] as const;
export type DeskDemoState = (typeof DESK_DEMO_STATES)[number];

export function isDeskDemoState(value: unknown): value is DeskDemoState {
  return typeof value === 'string' && (DESK_DEMO_STATES as readonly string[]).includes(value);
}

/** The PIN of a screen the demo starts paired. */
export const DESK_DEMO_PIN = '246810';

const MIN = 60_000;

/** The box has a camera (DK-28) and speaks with the six voices (DK-50). */
const CAMERA: FakeDeskOptions['hardware'] = { presenceAvailable: true, voices: [...DESK_VOICES] };
/** The screens a box reads (DK-16). */
const PANEL: DeskDisplay = { connected: true, real: true, builtIn: true, name: null };
const DELL: DeskDisplay = { connected: true, real: true, builtIn: false, name: 'DELL U2720Q' };
const QEMU: DeskDisplay = { connected: true, real: false, builtIn: false, name: 'QEMU Monitor' };
const NONE: DeskDisplay = { connected: false, real: false, builtIn: false, name: null };
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const AC: HostPower = {
  source: 'ac',
  percent: 80,
  charging: false,
  minutesLeft: null,
  chargeLimit: 80,
  since: null,
};

/** The fake screen's options and the box's power for a state at `now`. */
export function deskDemoSetup(
  state: DeskDemoState,
  { me, now }: { me: { id: string; name: string }; now: number },
): {
  options: Pick<FakeDeskOptions, 'hardware' | 'display' | 'initial'>;
  power: HostPower | null;
} {
  const pairedWith = (who: { personId: string; name: string }) => ({
    paired: { ...who, pairedAt: iso(now - 26 * 24 * 60 * MIN), pin: DESK_DEMO_PIN },
    settings: DEFAULT_DESK_SETTINGS,
  });
  const mine = pairedWith({ personId: me.id, name: me.name });
  const chosen = (snapshot: ReturnType<typeof pairedWith>) => ({
    ...snapshot,
    paired: { ...snapshot.paired, self: false },
    on: true,
  });
  switch (state) {
    case 'auto':
      return {
        options: {
          display: PANEL,
          hardware: CAMERA,
          initial: {
            paired: {
              personId: me.id,
              name: me.name,
              pairedAt: iso(now - 3 * 60 * MIN),
              pin: null,
              self: true,
            },
            settings: DEFAULT_DESK_SETTINGS,
            on: null,
          },
        },
        power: AC,
      };
    case 'pinned':
    case 'older':
      return {
        options: { display: PANEL, hardware: CAMERA, initial: chosen(mine) },
        power: AC,
      };
    case 'nocamera':
      return {
        options: {
          display: DELL,
          hardware: { voices: [...DESK_VOICES] },
          initial: chosen(mine),
        },
        power: AC,
      };
    case 'off':
      return {
        options: { display: DELL, initial: { paired: null, settings: DEFAULT_DESK_SETTINGS, on: false } },
        power: AC,
      };
    case 'vm':
      return {
        options: {
          display: QEMU,
          hardware: { hasMicrophone: false, hasSpeaker: false, hasBattery: false, voiceAvailable: false },
          initial: null,
        },
        power: null,
      };
    case 'unplugged':
      return { options: { display: NONE, initial: chosen(mine) }, power: AC };
    case 'unpaired':
    case 'pairing':
      return { options: { initial: null }, power: AC };
    case 'paired':
    case 'unlock':
      return { options: { initial: mine }, power: AC };
    case 'no-mic':
      return {
        options: { initial: mine, hardware: { hasMicrophone: false, voiceAvailable: false } },
        power: AC,
      };
    case 'no-voice':
      return { options: { initial: mine, hardware: { voiceAvailable: false } }, power: AC };
    case 'none':
      return {
        options: {
          display: NONE,
          initial: null,
          hardware: {
            hasDisplay: false,
            hasMicrophone: false,
            hasSpeaker: false,
            hasBattery: false,
            voiceAvailable: false,
          },
        },
        power: null,
      };
    case 'battery':
      return {
        options: { initial: mine },
        power: { ...AC, source: 'battery', percent: 62, minutesLeft: 190, since: iso(now - 27 * MIN) },
      };
    case 'charging':
      return { options: { initial: mine }, power: { ...AC, percent: 64, charging: true } };
  }
}

export interface DemoDeskOptions {
  /**
   * The clock (epoch ms; default `Date.now`). Real time, not the demo world's 14:05: the shared hooks count the letters'
   * and the unlock request's time left with `Date.now()`, as against a real Whombat.
   */
  now?: () => number;
  me: { id: string; name: string };
  state?: DeskDemoState;
  /** After the first pairing, the screen asks to unlock this much later; null: never. */
  unlockAfterPairMs?: number | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface DemoDesk {
  /** `desk.*` for the demo's viewer. */
  api: DeskApi;
  /** The screen's side: its letters while pairing, “Confirm on your phone”. */
  screen(): FakeDesk;
  /** `HostNow.power` for the demo's How it's doing. */
  power(): HostPower | null;
  /** Start over in a state. */
  reset(state: DeskDemoState): void;
  /** The six letters the demo's waiting tablet shows (nothing shows them in the demo world), or null. */
  waitingLetters(): string | null;
  /** After every change on the screen's side (the runtime's `desk.changed`). */
  onChange(listener: () => void): () => void;
}

export function createDemoDesk(options: DemoDeskOptions): DemoDesk {
  const { me } = options;
  const now = options.now ?? Date.now;
  const viewer: FakeDeskPerson = { personId: me.id, name: me.name };
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const unlockAfterPairMs = options.unlockAfterPairMs === undefined ? 6_000 : options.unlockAfterPairMs;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of [...listeners]) l();
  };
  let desk!: FakeDesk;
  let power: HostPower | null = null;
  let off: () => void = () => {};
  let timer: unknown = null;
  let asked = false;
  // A tablet waiting to become a screen (DK-146), so Add a screen has letters to take.
  let tablets = 0;
  const tablet = () => `demo_tablet_${tablets}`;
  const waitTablet = () => {
    tablets += 1;
    desk.screenCall(
      'enroll.display.request',
      { endpoint: { label: 'iPad · Safari', platform: 'web' } },
      tablet(),
    );
  };

  const reset = (state: DeskDemoState) => {
    off();
    if (timer !== null) clearTimer(timer);
    timer = null;
    const setup = deskDemoSetup(state, { me, now: now() });
    desk = createFakeDesk({ now, ...setup.options, screens: state !== 'older' });
    tablets = 0;
    waitTablet();
    power = setup.power;
    asked = state !== 'unpaired' && state !== 'pairing' && state !== 'off' && state !== 'vm';
    let wasMine = desk.snapshot().paired?.personId === me.id;
    off = desk.onChange(() => {
      const mine = desk.snapshot().paired?.personId === me.id;
      // Paired just now: the screen asks to unlock once, a little later.
      if (mine && !wasMine && !asked && unlockAfterPairMs !== null) {
        asked = true;
        timer = setTimer(() => {
          timer = null;
          desk.requestUnlock();
        }, unlockAfterPairMs);
      }
      wasMine = mine;
      // The tablet that waited is a screen now: another waits with new letters.
      if (!desk.displayLetters(tablet())) waitTablet();
      emit();
    });
    if (state === 'pairing') desk.call('desk.startPairing', {}, viewer);
    if (state === 'unlock') desk.requestUnlock();
    emit();
  };
  reset(options.state ?? 'auto');

  const call = () => fakeDeskApi(desk, viewer);
  const api: DeskApi = {
    get: () => call().get(),
    startPairing: () => call().startPairing(),
    pair: (input) => call().pair(input),
    setPin: (pin) => call().setPin(pin),
    update: (patch) => call().update(patch),
    unpair: () => call().unpair(),
    setScreen: (on) => call().setScreen(on),
    answerUnlock: (input) => call().answerUnlock(input),
    voiceSample: (voice) => call().voiceSample(voice),
    preview: (input) => call().preview(input),
    tryOnScreen: (input) => call().tryOnScreen(input),
    setName: (name) => call().setName(name),
    screens: () => call().screens(),
    screen: (id) => call().screen(id),
    updateScreen: (input) => call().updateScreen(input),
    screenViews: (input) => call().screenViews(input),
    tryScreen: (input) => call().tryScreen(input),
    addScreen: (input) => call().addScreen(input),
    removeScreen: (id) => call().removeScreen(id),
    widgets: (input) => call().widgets(input),
  };
  return {
    api,
    screen: () => desk,
    power: () => power,
    reset,
    waitingLetters() {
      // Letters work for 10 minutes: past that, the tablet asks for new ones.
      if (!desk.displayLetters(tablet())) waitTablet();
      return desk.displayLetters(tablet());
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let demo: DemoDesk | null = null;

/** The demo world's one desk, made on first use; it keeps its state while the app runs. */
export function demoDesk(options: DemoDeskOptions): DemoDesk {
  demo ??= createDemoDesk(options);
  return demo;
}
