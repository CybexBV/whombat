import { applyDeskSettingsPatch } from '@whombat/core';
/**
 * A desk screen without a box (Whombat desk-display.md DK-02…DK-04, DK-16…DK-20, DK-26…DK-28, DK-72, DK-74; app
 * desk-display-web.md AP-3012, AP-3104, AP-3300…, AP-3600…): the `desk.*` ops as the runtime answers them, in memory, for the web's fixture mode and
 * managed fake world, the phone's demo world and tests. With a `display` it answers as a 0.101 runtime (what the screen
 * is, the switch, `desk.setScreen`, a pairing without a PIN, `desk.unpair` turning the screen off); without one as a
 * 0.100 runtime. PINs of 4 to 6 digits, none too easy (`easy_pin`), and `presence` among the choices as 0.103 has them;
 * `presenceAvailable` only where `hardware` says so. The voices as 0.105 has them where `hardware` lists `voices`: the
 * choice `speechVoice` (`no_voice` for one the box doesn't list) and `desk.voiceSample`, a short tone per voice as a
 * WAV (a lower one for the men), larger than one session message as the box's sentence is. With `lockAgain` it
 * answers as 0.107 does: *Lock again*'s choices (`idle` and `never`, `away` where `presenceAvailable`), the camera's
 * `cameraWakeAvailable` (as `presenceAvailable`), and `stayUnlocked` and `cameraWake` among the choices; without it,
 * a runtime from before refuses both members as its strict input does.
 * The screen's side is in reach too: the letters it shows while pairing, and “Confirm on your phone” (an unlock
 * request). The clock and the letters are injectable.
 */
import { sizeOf } from '@whombat/screen';
import { OperationError } from '../session/managed-ops';
import { base64 } from '../svg';
import type { DeskApi, DisplayEnrolApi, ScreenApi } from './api';
import { screenImageBytes } from './api';
import {
  applyDeskShowPatch,
  DEFAULT_DESK_SETTINGS,
  DEFAULT_DESK_SHOW,
  DESK_DEFAULT_SHAPE,
  DESK_PAIRING_TTL_S,
  DESK_PHONE_UNLOCK_TTL_S,
  DESK_PIN_RE,
  DESK_SCREEN_CODE_TTL_S,
  DESK_SCREEN_UNLOCK_IDLE_S,
  DESK_SCREEN_WORDS,
  DESK_SCREENS_MAX,
  DESK_TRIES,
  DESK_TRY_S,
  DESK_VOICES,
  type DeskDisplay,
  type DeskErrorCode,
  type DeskLayout,
  DeskPreviewInput,
  type DeskScreen,
  DeskScreenAddInput,
  type DeskScreenDetail,
  type DeskScreenSummary,
  DeskScreenUpdateInput,
  DeskScreenViewsInput,
  DeskSetNameInput,
  type DeskSettings,
  type DeskShow,
  type DeskUpdateInput,
  type DeskVoice,
  type DeskVoiceSample,
  type DeskWidget,
  type DeskWidgetView,
  deskAttentionFor,
  deskCalmFor,
  deskEmptyPage,
  deskLayoutProblem,
  deskLayoutWidgets,
  deskPinBackoffS,
  deskPinTooEasy,
  ScreenImage,
  type ScreenLock,
  type ScreenState,
} from './contract';
import { type FakeScreen, fakeCatalog, fakeScreensSeed, fakeViews } from './fakeScreens';
import {
  defaultFakeDeskWorld,
  type FakeDeskWorld,
  fakeDeskCalm,
  fakeDeskCalmInput,
  fakeDeskPreview,
  fakeDeskShowOptions,
} from './fakeWorld';
import { deskLetters, deskSampleWav } from './model';

export { defaultFakeDeskWorld, type FakeDeskWorld } from './fakeWorld';

/** Who calls: the person whose Whombat it is (Whombat one-person.md OP-01). */
export interface FakeDeskPerson {
  personId: string;
  name: string;
}

/** What survives a reload (a runtime restart ends a pairing and locks the screen, so only these). */
export interface FakeDeskSnapshot {
  /** `pin` null: none chosen yet (DK-18); `self`: it paired itself, or was turned on, rather than by its letters. */
  paired: { personId: string; name: string; pairedAt: string; pin: string | null; self?: boolean } | null;
  settings: DeskSettings;
  /** What the person chose for *Show Whombat on this screen* (DK-20); null or absent: not chosen yet. */
  on?: boolean | null;
  /** The Whombat's name the app gave (3.2, DK-119). */
  name?: string | null;
  /** The screens (3.6) and the choices of each screen besides the box's own (the box's are `settings.show`). */
  screens?: FakeScreen[];
  shows?: Record<string, DeskShow>;
}

export interface FakeDeskOptions {
  now?: () => number;
  /** The letters the screen draws, in turn (default a fixed list, so a fixture's letters are known). */
  letters?: () => string;
  /**
   * The machine (default: a Z13 on the desk — display, microphone, speakers, battery, speech). `voices`: the voices the
   * box can speak with (0.105; default none listed, a runtime from before).
   */
  hardware?: Partial<
    Pick<
      DeskScreen,
      | 'hasDisplay'
      | 'hasMicrophone'
      | 'hasSpeaker'
      | 'hasBattery'
      | 'voiceAvailable'
      | 'presenceAvailable'
      | 'voices'
    >
  >;
  /** The screen the box drives (DK-16). Default: a real built-in one, connected. */
  display?: DeskDisplay;
  initial?: FakeDeskSnapshot | null;
  /**
   * What the box has to show (3.2, DK-106, DK-123): Settings → Screen's lists and its preview. Default the mockups'
   * world; `null` answers as a runtime before 3.2 (no lists, no preview, no name).
   */
  world?: FakeDeskWorld | null;
  /**
   * Screens of widgets (3.6, DK-126…DK-149): `desk.screens` and the rest with the mockups' screens (the box's own, an
   * office monitor and a kitchen tablet), and the devices' side through `screenCall`. Default off: a runtime before 3.6
   * answers `unknown_op`, so the older worlds keep the *Screen* tab.
   */
  screens?: boolean;
}

export interface FakeDesk {
  /** One `desk.*` op as the runtime answers it. */
  call(op: string, input: unknown, viewer: FakeDeskPerson): { status: number; body: unknown };
  /** The letters on the screen while pairing, or null. */
  letters(): string | null;
  /** The screen's “Confirm on your phone”: a request to the person for 2 minutes. */
  requestUnlock(): void;
  /** Whether the person let the screen in. */
  unlocked(): boolean;
  /** After every change (the runtime's `desk.changed`). */
  onChange(listener: () => void): () => void;
  snapshot(): FakeDeskSnapshot;
  /**
   * A device's own ops (3.6, DK-146), `endpoint` its id: `enroll.display.request` and `enroll.display.status` while
   * it waits to become a screen, then only `screen.state`, `screen.unlock`, `screen.lock` and `screen.image`.
   */
  screenCall(op: string, input: unknown, endpoint: string): { status: number; body: unknown };
  /** The six letters a device shows while it waits, by its endpoint; null when it doesn't. */
  displayLetters(endpoint: string): string | null;
}

const LETTERS = ['KXQM', 'TRAW', 'HNVB', 'PDGY', 'CJEF'];
/** The six letters devices show in turn (no I or O, as the contract's). */
const DISPLAY_LETTERS = ['KTRMWP', 'HNVBQX', 'PDGYCE', 'ZSLAFU'];

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ok = (body: unknown) => ({ status: 200, body });
const err = (status: number, code: string, message: string, details?: unknown) => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});
/** A `desk.*` refusal as the runtime sends it: the generic code and status, the desk's code in `details` (CT-525). */
const REFUSALS: Record<DeskErrorCode, [number, string]> = {
  wrong_code: [403, 'forbidden'],
  pairing_expired: [410, 'expired'],
  not_paired: [409, 'conflict'],
  request_expired: [410, 'expired'],
  no_screen: [409, 'conflict'],
  no_pin: [409, 'conflict'],
  easy_pin: [400, 'validation_failed'],
  no_voice: [409, 'conflict'],
  unknown_screen: [404, 'not_found'],
  screens_full: [409, 'conflict'],
  bad_layout: [400, 'validation_failed'],
};
const refuse = (code: DeskErrorCode, more: { triesLeft?: number } = {}) => {
  const [status, generic] = REFUSALS[code];
  return err(status, generic, code, { code, ...more });
};
/** A strict input that doesn't take a member (a runtime from before it). */
const invalid = () => err(400, 'validation_failed', 'The request input is not valid.');

/** Each voice's tone in the fake: the women higher, the men lower. */
const TONES: Record<DeskVoice, number> = {
  heart: 440,
  bella: 494,
  michael: 220,
  fenrir: 196,
  emma: 523,
  george: 247,
};

/**
 * A tone as the box's voice answers (16-bit mono WAV at Kokoro's 24 kHz), faded in and out: 1.6 s, about 77 KB, so a
 * sample crosses one session message (64 KiB) as the box's sentence does.
 */
export function deskToneWav(hz: number, seconds = 1.6, rate = 24_000): Uint8Array {
  const n = Math.round(seconds * rate);
  const out = new Uint8Array(44 + n * 2);
  const v = new DataView(out.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, n * 2, true);
  const fade = rate * 0.05;
  for (let i = 0; i < n; i++) {
    const level = Math.min(1, i / fade, (n - i) / fade) * 0.2;
    v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * level * 32767), true);
  }
  return out;
}

const samples = new Map<DeskVoice, string>();
/** `desk.voiceSample`'s answer for a voice (made once). */
function sampleOf(voice: DeskVoice): DeskVoiceSample {
  let audioWav = samples.get(voice);
  if (!audioWav) {
    audioWav = base64(deskToneWav(TONES[voice]));
    samples.set(voice, audioWav);
  }
  return { audioWav };
}
const isDeskVoice = (v: unknown): v is DeskVoice =>
  typeof v === 'string' && (DESK_VOICES as readonly string[]).includes(v);

export function createFakeDesk(options: FakeDeskOptions = {}): FakeDesk {
  const now = options.now ?? Date.now;
  let turn = 0;
  const draw = options.letters ?? (() => LETTERS[turn++ % LETTERS.length] as string);
  const hardware = {
    hasDisplay: true,
    hasMicrophone: true,
    hasSpeaker: true,
    hasBattery: true,
    voiceAvailable: true,
    presenceAvailable: false,
    ...options.hardware,
  };
  const display: DeskDisplay = options.display ?? { connected: true, real: true, builtIn: true, name: null };
  hardware.hasDisplay = display.connected;
  // DK-74: `away` only where the camera works; the camera's own switch the same (DK-72).
  const camera = hardware.presenceAvailable === true;
  const lockAgain: Pick<DeskScreen, 'lockAgain' | 'cameraWakeAvailable'> = {
    lockAgain: camera ? ['idle', 'away', 'never'] : ['idle', 'never'],
    cameraWakeAvailable: camera,
  };
  let paired = options.initial?.paired ?? null;
  // A snapshot kept from before a choice existed takes its default (`presence`, 0.103; `stayUnlocked`, 0.107).
  let settings: DeskSettings = { ...DEFAULT_DESK_SETTINGS, ...options.initial?.settings };
  let chosen: boolean | null = options.initial?.on ?? null;
  const world = options.world === undefined ? defaultFakeDeskWorld() : options.world;
  let name: string | null = options.initial?.name ?? null;
  // The switch now (DK-20): what the person chose, else whether the screen is a real one.
  const isOn = () => chosen ?? display.real;
  let pairing: { code: string; expiresAt: number; wrong: number } | null = null;
  let request: { id: string; expiresAt: number } | null = null;
  let isUnlocked = false;
  let requests = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of [...listeners]) l();
  };
  // Screens of widgets (3.6): the screens, each one's choices, the devices waiting with their letters, and the screens
  // elsewhere that were unlocked with the PIN (memory only, as the runtime's).
  const screensOn = options.screens === true && world !== null;
  let screens: FakeScreen[] = screensOn ? (options.initial?.screens ?? fakeScreensSeed(now())) : [];
  const shows = new Map<string, DeskShow>(Object.entries(options.initial?.shows ?? {}));
  let displayTurn = 0;
  let added = 0;
  const displays = new Map<
    string,
    { requestId: string; code: string; label: string; expiresAt: number; screen?: string }
  >();
  const unlocks = new Map<string, { until: number; wrong: number; retryAt: number }>();
  let trying: { screen: string; layout: DeskLayout; until: number } | null = null;

  const live = <T extends { expiresAt: number }>(x: T | null): T | null =>
    x && x.expiresAt > now() ? x : null;

  function screen(): DeskScreen {
    const p = live(pairing);
    const r = paired ? live(request) : null;
    return {
      paired: paired && {
        personId: paired.personId,
        name: paired.name,
        pairedAt: paired.pairedAt,
        hasPin: paired.pin !== null,
        self: paired.self === true,
      },
      settings,
      pairing: p && { expiresAt: iso(p.expiresAt) },
      unlockRequest: r && { id: r.id, expiresAt: iso(r.expiresAt) },
      ...hardware,
      ...lockAgain,
      display: { ...display },
      on: isOn(),
      onChosen: chosen !== null,
      ...(world
        ? {
            ...(paired ? { showOptions: fakeDeskShowOptions(world, settings.show) } : {}),
            whombatName: name,
          }
        : {}),
    };
  }

  /** Nobody paired, the screen locked, its choices back to the defaults. */
  function unpair() {
    paired = null;
    settings = DEFAULT_DESK_SETTINGS;
    request = null;
    isUnlocked = false;
  }

  /** Paired with the person (its choices kept, DK-02); `pin` null: none yet (DK-18). */
  function pairWith(viewer: FakeDeskPerson, pin: string | null, self: boolean) {
    paired = { personId: viewer.personId, name: viewer.name, pairedAt: iso(now()), pin, self };
    pairing = null;
    request = null;
    isUnlocked = false;
  }

  function startPairing() {
    pairing = { code: draw(), expiresAt: now() + DESK_PAIRING_TTL_S * 1000, wrong: 0 };
    changed();
    return pairing;
  }

  /* Screens of widgets (3.6) ------------------------------------------------------------------------------------ */

  const isoNow = () => iso(now());
  const showOf = (id: string): DeskShow =>
    id === 'box' ? settings.show : (shows.get(id) ?? DEFAULT_DESK_SHOW);
  const findScreen = (id: unknown) => screens.find((x) => x.id === id);
  const ORDER: Record<FakeScreen['kind'], number> = { box: 0, output: 1, device: 2 };
  const others = () => screens.filter((x) => x.kind !== 'box').length;

  function summaryOf(x: FakeScreen): DeskScreenSummary {
    return {
      id: x.id,
      kind: x.kind,
      name: x.name,
      popups: x.popups,
      size: x.size,
      pages: x.layout.pages.length,
      online: x.online,
      lastSeenAt: x.lastSeenAt,
      ...(x.device ? { device: x.device } : {}),
    };
  }
  const detailOf = (x: FakeScreen): DeskScreenDetail => ({
    ...summaryOf(x),
    layout: x.layout,
    show: showOf(x.id),
  });

  /** Why a layout can't be kept: the contract's checks, then every widget within its sizes (`@whombat/screen`). */
  function layoutProblem(layout: DeskLayout): string | null {
    const problem = deskLayoutProblem(layout);
    if (problem) return problem;
    for (const pg of layout.pages)
      for (const widgets of Object.values(pg.layouts))
        for (const w of widgets) {
          const size = sizeOf(w, panelViewOf(w));
          if (w.w < size.min[0] || w.h < size.min[1] || w.w > size.max[0] || w.h > size.max[1])
            return `${w.id} is ${w.w} × ${w.h}`;
        }
    return null;
  }
  const panelViewOf = (w: Pick<DeskWidget, 'id' | 'type' | 'ref' | 'opts'>) =>
    w.type === 'panel' ? fakeViews(world as FakeDeskWorld, [w])[0]?.kind : undefined;

  function screenOp(op: string, raw: unknown) {
    const w = world as FakeDeskWorld;
    const input = (raw ?? {}) as Record<string, unknown>;
    switch (op) {
      case 'desk.screens':
        return ok({
          screens: [...screens].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]).map(summaryOf),
          canAdd: others() < DESK_SCREENS_MAX,
        });
      case 'desk.screen.get': {
        const x = findScreen(input.screen);
        return x ? ok(detailOf(x)) : refuse('unknown_screen');
      }
      case 'desk.screen.update': {
        const parsed = DeskScreenUpdateInput.safeParse(raw);
        if (!parsed.success) return invalid();
        const x = findScreen(parsed.data.screen);
        if (!x) return refuse('unknown_screen');
        if (parsed.data.layout && layoutProblem(parsed.data.layout)) return refuse('bad_layout');
        // The box's own choices are its screen settings: nobody's while it isn't paired.
        if (x.kind === 'box' && parsed.data.show && !paired) return refuse('not_paired');
        const next: FakeScreen = {
          ...x,
          // The box's own screen keeps the Whombat's name: a new one is ignored, as the runtime does.
          ...(parsed.data.name !== undefined && x.kind !== 'box' ? { name: parsed.data.name } : {}),
          ...(parsed.data.popups ? { popups: parsed.data.popups } : {}),
          ...(parsed.data.layout ? { layout: parsed.data.layout } : {}),
        };
        screens = screens.map((y) => (y.id === x.id ? next : y));
        if (parsed.data.show) {
          const show = applyDeskShowPatch(showOf(x.id), parsed.data.show);
          if (x.id === 'box') settings = { ...settings, show };
          else shows.set(x.id, show);
        }
        changed();
        return ok(detailOf(next));
      }
      case 'desk.screen.views': {
        const parsed = DeskScreenViewsInput.safeParse(raw);
        if (!parsed.success) return invalid();
        const x = findScreen(parsed.data.screen);
        if (!x) return refuse('unknown_screen');
        const scenario = parsed.data.scenario ?? 'now';
        const show = showOf(x.id);
        const at = new Date(now());
        return ok({
          name: name ?? w.burrow,
          calm: fakeDeskCalm(w, show, scenario, at),
          views: fakeViews(w, parsed.data.widgets, scenario),
          attention: deskAttentionFor(fakeDeskCalmInput(w, show, scenario, at), show, 'everything', x.popups),
        });
      }
      case 'desk.screen.try': {
        const x = findScreen(input.screen);
        if (!x) return refuse('unknown_screen');
        const layout = input.layout as DeskLayout | undefined;
        if (!layout || layoutProblem(layout)) return refuse('bad_layout');
        trying = { screen: x.id, layout, until: now() + DESK_TRY_S * 1000 };
        return ok({ until: iso(trying.until) });
      }
      case 'desk.screen.add': {
        const parsed = DeskScreenAddInput.safeParse(raw);
        if (!parsed.success) return invalid();
        const waiting = [...displays.entries()].find(([, d]) => d.code === parsed.data.code && !d.screen);
        if (!waiting) return refuse('wrong_code', { triesLeft: DESK_TRIES });
        const [endpoint, request] = waiting;
        if (request.expiresAt <= now()) return refuse('pairing_expired');
        if (others() >= DESK_SCREENS_MAX) return refuse('screens_full');
        added += 1;
        const box = findScreen('box');
        const layout: DeskLayout =
          parsed.data.start === 'copy' && box
            ? structuredClone(box.layout)
            : {
                pages: [deskEmptyPage('p_first', DESK_SCREEN_WORDS.firstPage, DESK_DEFAULT_SHAPE)],
                turn: 'touch',
                size: 'normal',
              };
        const screen: FakeScreen = {
          id: `scr_added_${String(added).padStart(3, '0')}`,
          kind: 'device',
          name: parsed.data.name,
          popups: parsed.data.popups,
          size: null,
          layout,
          online: true,
          lastSeenAt: isoNow(),
          // The runtime shows the endpoint's “Safari on iPad” as “iPad · Safari”.
          device: request.label.replace(/^(.+) on (.+)$/, '$2 · $1'),
          endpoint,
        };
        screens = [...screens, screen];
        request.screen = screen.id;
        changed();
        return ok(detailOf(screen));
      }
      case 'desk.screen.remove': {
        const x = findScreen(input.screen);
        if (!x) return refuse('unknown_screen');
        if (x.kind === 'box') return invalid();
        screens = screens.filter((y) => y.id !== x.id);
        shows.delete(x.id);
        if (x.endpoint) unlocks.delete(x.endpoint);
        changed();
        return ok({ ok: true });
      }
      case 'desk.widgets': {
        if (!findScreen(input.screen)) return refuse('unknown_screen');
        return ok(fakeCatalog(w, typeof input.thing === 'string' ? input.thing : undefined));
      }
      default:
        return err(404, 'unknown_op', `No operation ${op}`);
    }
  }

  /** A screen elsewhere's lock (DK-138): unlocked with the PIN until it's left alone, else as the box's lock shows. */
  function lockOf(endpoint: string): ScreenLock {
    const u = unlocks.get(endpoint);
    const hasPin = paired?.pin != null;
    const base = { view: settings.lockedView, hasPin };
    if (u && u.retryAt > now()) return { ...base, state: 'backoff', retryAt: iso(u.retryAt), triesLeft: 0 };
    if (u && u.until > now()) return { ...base, state: 'unlocked', until: iso(u.until) };
    return {
      ...base,
      state: 'locked',
      ...(u?.wrong ? { triesLeft: Math.max(0, DESK_TRIES - u.wrong) } : {}),
    };
  }

  /** What a locked screen leaves out of a view (DK-138): the words and pictures it marks private. */
  function trimmed(v: DeskWidgetView): DeskWidgetView {
    if (v.kind === 'camera')
      return {
        id: v.id,
        kind: 'camera',
        title: v.title,
        ...(v.mark ? { mark: v.mark } : {}),
        ...(v.name ? { name: v.name } : {}),
        locked: true,
      };
    if (v.kind === 'posters' && v.title === 'Now playing') return { ...v, items: [], locked: true };
    if (v.kind === 'list' && v.title === 'Today') return { ...v, rows: [], locked: true };
    return v;
  }

  function screenState(x: FakeScreen, known: string | undefined) {
    const w = world as FakeDeskWorld;
    const lock = lockOf(x.endpoint as string);
    const view = lock.state === 'unlocked' ? 'everything' : settings.lockedView;
    const show = showOf(x.id);
    const at = new Date(now());
    const t = trying && trying.screen === x.id && trying.until > now() ? trying : null;
    const layout = t ? t.layout : x.layout;
    const views = fakeViews(w, deskLayoutWidgets(layout));
    const body: Omit<ScreenState, 'etag' | 'now'> = {
      screen: { id: x.id, name: x.name, popups: x.popups },
      whombat: name ?? w.burrow,
      lock,
      calm: view === 'time' ? null : deskCalmFor(fakeDeskCalmInput(w, show, 'now', at), show, view),
      grid:
        view === 'time'
          ? null
          : {
              screen: x.id,
              layout,
              views: view === 'summary' ? views.map(trimmed) : views,
              attention: deskAttentionFor(fakeDeskCalmInput(w, show, 'now', at), show, view, x.popups),
              popups: x.popups,
              ...(t ? { trying: { until: iso(t.until) } } : {}),
            },
    };
    // The clock's minute changes the drawing, so it's part of what “the same” means.
    const etag = hashOf(JSON.stringify(body) + isoNow().slice(0, 16));
    if (known === etag) return ok({ same: true, etag });
    return ok({ etag, now: isoNow(), ...body });
  }

  function screenCall(op: string, raw: unknown, endpoint: string) {
    const input = (raw ?? {}) as Record<string, unknown>;
    if (!screensOn) return err(404, 'unknown_op', `No operation ${op}`);
    if (op === 'enroll.display.request') {
      const label =
        typeof (input.endpoint as { label?: unknown } | undefined)?.label === 'string'
          ? ((input.endpoint as { label: string }).label as string)
          : DESK_SCREEN_WORDS.device;
      const request = {
        requestId: `display_${endpoint}_${displayTurn}`.replace(/[^A-Za-z0-9_-]/g, '_'),
        code: DISPLAY_LETTERS[displayTurn++ % DISPLAY_LETTERS.length] as string,
        label,
        expiresAt: now() + DESK_SCREEN_CODE_TTL_S * 1000,
      };
      displays.set(endpoint, request);
      return ok({ requestId: request.requestId, code: request.code, expiresAt: iso(request.expiresAt) });
    }
    if (op === 'enroll.display.status') {
      const request = [...displays.values()].find((d) => d.requestId === input.requestId);
      if (!request) return err(404, 'not_found', 'No such request.');
      const screen = request.screen ? findScreen(request.screen) : undefined;
      if (screen) return ok({ state: 'added', screen: { id: screen.id, name: screen.name } });
      return ok({ state: request.expiresAt > now() ? 'waiting' : 'expired' });
    }
    // The screen channel: only a screen's endpoint; a removed one is revoked.
    const x = screens.find((y) => y.endpoint === endpoint);
    if (!op.startsWith('screen.')) return err(404, 'unknown_op', `No operation ${op}`);
    if (!x) return err(403, 'revoked', 'This endpoint was revoked.');
    switch (op) {
      case 'screen.state': {
        const size = input.size as { width?: unknown; height?: unknown } | undefined;
        if (typeof size?.width !== 'number' || typeof size.height !== 'number') return invalid();
        const u = unlocks.get(endpoint);
        // Any state asked while unlocked is use: it stays unlocked for the next two minutes.
        if (u && u.until > now()) u.until = now() + DESK_SCREEN_UNLOCK_IDLE_S * 1000;
        const next = {
          ...x,
          size: { width: size.width, height: size.height },
          online: true,
          lastSeenAt: isoNow(),
        };
        screens = screens.map((y) => (y.id === x.id ? next : y));
        return screenState(next, typeof input.known === 'string' ? input.known : undefined);
      }
      case 'screen.unlock': {
        const pin = typeof input.pin === 'string' ? input.pin : '';
        const u = unlocks.get(endpoint) ?? { until: 0, wrong: 0, retryAt: 0 };
        unlocks.set(endpoint, u);
        if (!paired?.pin || u.retryAt > now()) return ok(lockOf(endpoint));
        if (pin === paired.pin) {
          u.wrong = 0;
          u.until = now() + DESK_SCREEN_UNLOCK_IDLE_S * 1000;
        } else {
          u.wrong += 1;
          const wait = deskPinBackoffS(u.wrong);
          if (wait > 0) u.retryAt = now() + wait * 1000;
        }
        return ok(lockOf(endpoint));
      }
      case 'screen.lock':
        unlocks.delete(endpoint);
        return ok(lockOf(endpoint));
      case 'screen.image':
        // The fake's views name no pictures.
        return err(404, 'not_found', 'No such picture.');
      default:
        return err(404, 'unknown_op', `No operation ${op}`);
    }
  }

  function call(op: string, raw: unknown, viewer: FakeDeskPerson) {
    const input = (raw ?? {}) as Record<string, unknown>;
    switch (op) {
      case 'desk.get':
        return ok(screen());
      case 'desk.startPairing':
        return ok({ expiresAt: iso(startPairing().expiresAt) });
      case 'desk.pair': {
        const p = live(pairing);
        if (!p) return refuse('pairing_expired');
        const pin = typeof input.pin === 'string' ? input.pin : '';
        if (!DESK_PIN_RE.test(pin)) return err(400, 'invalid_input', 'The PIN is 4 to 6 digits.');
        // Before the letters are tried, so an easy PIN uses up none of them (DK-27).
        if (deskPinTooEasy(pin)) return refuse('easy_pin');
        if (deskLetters(typeof input.code === 'string' ? input.code : '') !== p.code) {
          p.wrong += 1;
          const triesLeft = DESK_TRIES - p.wrong;
          if (triesLeft <= 0) startPairing();
          return refuse('wrong_code', { triesLeft: Math.max(0, triesLeft) });
        }
        // Pairing again replaces the last pairing (DK-02); pairing by the letters turns it on.
        pairWith(viewer, pin, false);
        if (display) chosen = true;
        changed();
        return ok(screen());
      }
      case 'desk.setPin': {
        if (!paired) return refuse('not_paired');
        const pin = typeof input.pin === 'string' ? input.pin : '';
        if (!DESK_PIN_RE.test(pin)) return err(400, 'invalid_input', 'The PIN is 4 to 6 digits.');
        if (deskPinTooEasy(pin)) return refuse('easy_pin');
        paired = { ...paired, pin };
        changed();
        return ok(screen());
      }
      case 'desk.update': {
        if (!paired) return refuse('not_paired');
        const patch = input as DeskUpdateInput;
        // The voice (0.105): one the box lists; a runtime from before doesn't take the member.
        if ('speechVoice' in patch) {
          if (!hardware.voices || !isDeskVoice(patch.speechVoice)) return invalid();
          if (!hardware.voices.includes(patch.speechVoice)) return refuse('no_voice');
        }
        settings = applyDeskSettingsPatch(settings, patch);
        changed();
        return ok(screen());
      }
      case 'desk.unpair': {
        // With the switch, unpairing is turning the screen off (DK-20).
        if (display) chosen = false;
        unpair();
        changed();
        return ok(screen());
      }
      case 'desk.setScreen': {
        if (!display) return err(404, 'unknown_op', `No operation ${op}`);
        if (typeof input.on !== 'boolean') return err(400, 'invalid_input', 'on is true or false.');
        if (input.on) {
          // On pairs the screen to the person, without letters or a PIN (DK-18, DK-20).
          if (!display.connected) return refuse('no_screen');
          chosen = true;
          if (!paired) pairWith(viewer, null, true);
        } else {
          chosen = false;
          unpair();
        }
        changed();
        return ok(screen());
      }
      case 'desk.voiceSample': {
        // A runtime from before 0.105 has no such op; it lists no voices either.
        if (!hardware.voices) return err(404, 'unknown_op', `No operation ${op}`);
        if (!paired) return refuse('not_paired');
        if (!isDeskVoice(input.voice)) return invalid();
        if (!hardware.voiceAvailable || !hardware.voices.includes(input.voice)) return refuse('no_voice');
        return ok(sampleOf(input.voice));
      }
      case 'desk.preview':
      case 'desk.tryOnScreen': {
        // A runtime from before 3.2 has neither (DK-123, DK-124).
        if (!world) return err(404, 'unknown_op', `No operation ${op}`);
        if (!paired) return refuse('not_paired');
        const parsed = DeskPreviewInput.safeParse(raw);
        if (!parsed.success) return invalid();
        if (op === 'desk.tryOnScreen') return ok({ until: iso(now() + DESK_TRY_S * 1000) });
        const show = parsed.data.show ?? settings.show;
        return ok(fakeDeskPreview(world, show, parsed.data.scenario, name, new Date(now())));
      }
      case 'desk.setName': {
        if (!world) return err(404, 'unknown_op', `No operation ${op}`);
        const parsed = DeskSetNameInput.safeParse(raw);
        if (!parsed.success) return invalid();
        name = parsed.data.name;
        changed();
        return ok(screen());
      }
      case 'desk.screens':
      case 'desk.screen.get':
      case 'desk.screen.update':
      case 'desk.screen.views':
      case 'desk.screen.try':
      case 'desk.screen.add':
      case 'desk.screen.remove':
      case 'desk.widgets':
        return screensOn ? screenOp(op, raw) : err(404, 'unknown_op', `No operation ${op}`);
      case 'desk.answerUnlock': {
        if (!paired) return refuse('not_paired');
        const r = live(request);
        if (!r || r.id !== input.id) return refuse('request_expired');
        isUnlocked = input.unlock === true;
        request = null;
        changed();
        return ok({ ok: true });
      }
      default:
        return err(404, 'unknown_op', `No operation ${op}`);
    }
  }

  return {
    call,
    letters: () => live(pairing)?.code ?? null,
    requestUnlock() {
      if (!paired) return;
      requests += 1;
      request = { id: `unlock_${requests}`, expiresAt: now() + DESK_PHONE_UNLOCK_TTL_S * 1000 };
      changed();
    },
    unlocked: () => isUnlocked,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => ({
      paired,
      settings,
      ...(display ? { on: chosen } : {}),
      ...(name ? { name } : {}),
      ...(screensOn ? { screens, shows: Object.fromEntries(shows) } : {}),
    }),
    screenCall,
    displayLetters: (endpoint) => {
      const d = displays.get(endpoint);
      return d && !d.screen && d.expiresAt > now() ? d.code : null;
    },
  };
}

/** A short stable hash of a string (FNV-1a), base 36: the fake's `etag`. */
function hashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** A fake desk as `DeskApi` for one viewer: a refusal throws the `OperationError` the session would. */
export function fakeDeskApi(desk: FakeDesk, viewer: FakeDeskPerson): DeskApi {
  const call = async <T>(op: string, input: unknown = {}): Promise<T> => {
    const r = desk.call(op, input, viewer);
    if (r.status < 300) return r.body as T;
    const e = (r.body as { error: { code: string; message: string; details?: unknown } }).error;
    throw new OperationError(op, r.status, e.code, e.message, e.details);
  };
  return {
    get: () => call('desk.get'),
    startPairing: () => call('desk.startPairing'),
    pair: (input) => call('desk.pair', input),
    setPin: (pin) => call('desk.setPin', { pin }),
    update: (patch) => call('desk.update', patch),
    unpair: () => call('desk.unpair'),
    setScreen: (on) => call('desk.setScreen', { on }),
    answerUnlock: (input) => call('desk.answerUnlock', input),
    voiceSample: async (voice) => deskSampleWav(await call<DeskVoiceSample>('desk.voiceSample', { voice })),
    preview: (input) => call('desk.preview', input),
    tryOnScreen: (input) => call('desk.tryOnScreen', input),
    setName: (name) => call('desk.setName', { name }),
    screens: () => call('desk.screens'),
    screen: (id) => call('desk.screen.get', { screen: id }),
    updateScreen: (input) => call('desk.screen.update', input),
    screenViews: (input) => call('desk.screen.views', input),
    tryScreen: (input) => call('desk.screen.try', input),
    addScreen: (input) => call('desk.screen.add', input),
    removeScreen: (id) => call('desk.screen.remove', { screen: id }),
    widgets: (input) => call('desk.widgets', input),
  };
}

/** A fake device's side as the screen page's ops (3.6, DK-146): `endpoint` is the device's own id. */
export function fakeScreenDevice(
  desk: FakeDesk,
  endpoint: string,
): { enrol: DisplayEnrolApi; screen: ScreenApi } {
  const call = async <T>(op: string, input: unknown = {}): Promise<T> => {
    const r = desk.screenCall(op, input, endpoint);
    if (r.status < 300) return r.body as T;
    const e = (r.body as { error: { code: string; message: string; details?: unknown } }).error;
    throw new OperationError(op, r.status, e.code, e.message, e.details);
  };
  return {
    enrol: {
      request: (device) => call('enroll.display.request', { endpoint: device }),
      status: (requestId) => call('enroll.display.status', { requestId }),
    },
    screen: {
      state: (input) => call('screen.state', input),
      unlock: (pin) => call('screen.unlock', { pin }),
      lock: () => call('screen.lock'),
      image: async (input) => screenImageBytes(ScreenImage.parse(await call('screen.image', input))),
    },
  };
}
