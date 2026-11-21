import { describe, expect, it } from 'vitest';
import type { ConsoleState } from './api';
import { deskWordsSource } from './contractsSource';
import type { DeskAsk, DeskGlance, DeskPresence, DeskState } from './desk';
import {
  alertFor,
  askShown,
  attention,
  continueTalk,
  DESK_AWAY_MS,
  DESK_IDLE_MS,
  deskActive,
  deskScene,
  isIdle,
  isUnlocked,
  locksIn,
  mayListen,
  newAsk,
  nightLine,
  PAGE_MS,
  pageKept,
  SHOW_MS,
  sheetOver,
  shouldTouch,
  TOUCH_EVERY_MS,
  touchUnlocks,
  wakesOnly,
} from './deskScene';

const glance = (count = 0, bad = false): DeskGlance => ({
  status: { text: '', more: null },
  needsYou: { count, items: [] },
  working: null,
  done: [],
  servers: bad
    ? [{ name: 'pve-02', mark: null, state: 'bad', note: '', cpu: null, memory: null, temp: null }]
    : [],
  moreServers: 0,
  tiles: [],
  box: null,
});

const desk = (
  p: Partial<DeskState> = {},
  paired: Partial<NonNullable<DeskState['paired']>> = {},
): DeskState => ({
  now: '2026-10-20T12:34:00Z',
  paired: {
    person: { name: 'John', initial: 'J', tone: 3 },
    hasPin: true,
    assistant: { name: 'Neo', face: 'neo' },
    burrow: null,
    timeZone: 'UTC',
    lockedView: 'summary',
    night: 'dim',
    quiet: false,
    voice: true,
    ...paired,
  },
  pairing: null,
  lock: { state: 'locked', until: null, retryAt: null, expiresAt: null },
  glance: glance(),
  power: null,
  talk: null,
  ...p,
});

/** Whombat's clock in these tests, and a lock it sent unlocked until two minutes later. */
const SERVER_NOW = Date.parse('2026-10-20T12:34:00Z');
const unlocked = {
  state: 'unlocked',
  until: '2026-10-20T12:36:00Z',
  retryAt: null,
  expiresAt: null,
} as const;

describe('deskActive', () => {
  const con = (
    d: DeskState | null,
    claim: 'claimed' | 'claimable' | 'backoff' = 'claimed',
  ): ConsoleState => ({
    mode: 'console',
    now: '',
    footer: '',
    claim: { state: claim, code: 'KXQM', claimUrl: '', appUrl: '', retryAt: null, burrows: null },
    desk: d,
  });

  it('turns the console into the desk once paired or while pairing (DK-01, DK-02)', () => {
    expect(deskActive(con(desk()))).toBe(true);
    expect(deskActive(con(desk({ paired: null, pairing: { code: 'HBRT', expiresAt: '' } })))).toBe(true);
  });

  it('keeps today’s console without a desk or a pairing, and while a claim code shows', () => {
    expect(deskActive(con(null))).toBe(false);
    expect(deskActive(con(desk({ paired: null })))).toBe(false);
    expect(deskActive(con(desk(), 'claimable'))).toBe(false);
    expect(deskActive(con(desk(), 'backoff'))).toBe(false);
  });
});

describe('deskScene', () => {
  const now = 1_000_000;
  const at = { now, serverNow: SERVER_NOW, lastInput: now - 5 * 60_000, talkOpen: false };

  it('shows the pairing letters while Settings pairs, even on a paired screen', () => {
    expect(deskScene({ ...at, desk: desk({ pairing: { code: 'HBRT', expiresAt: '' } }) })).toBe('pairing');
  });

  it('shows the dim clock or black in quiet hours, the glance for a minute after a touch (DK-09)', () => {
    expect(deskScene({ ...at, desk: desk({}, { quiet: true }) })).toBe('night');
    expect(deskScene({ ...at, desk: desk({}, { quiet: true, night: 'black' }) })).toBe('black');
    expect(deskScene({ ...at, lastInput: now - SHOW_MS + 1, desk: desk({}, { quiet: true }) })).toBe(
      'glance',
    );
    expect(deskScene({ ...at, talkOpen: true, desk: desk({ lock: unlocked }, { quiet: true }) })).toBe(
      'talk',
    );
  });

  it('shows only the clock locked with “Only the time”, everything once unlocked (DK-03)', () => {
    expect(deskScene({ ...at, desk: desk({}, { lockedView: 'time' }) })).toBe('clock');
    expect(deskScene({ ...at, desk: desk({ lock: unlocked }, { lockedView: 'time' }) })).toBe('glance');
  });

  it('shows Talk only unlocked, with Talk’s voice or without (typing, DK-T12)', () => {
    expect(deskScene({ ...at, talkOpen: true, desk: desk({ lock: unlocked }) })).toBe('talk');
    expect(deskScene({ ...at, talkOpen: true, desk: desk() })).toBe('glance');
    expect(deskScene({ ...at, talkOpen: true, desk: desk({ lock: unlocked }, { voice: false }) })).toBe(
      'talk',
    );
  });

  it('counts an unlock whose time ran out by Whombat’s clock as locked (CG-51)', () => {
    const later = { ...at, serverNow: SERVER_NOW + 2 * 60_000 };
    expect(deskScene({ ...later, talkOpen: true, desk: desk({ lock: unlocked }) })).toBe('glance');
    expect(deskScene({ ...later, desk: desk({ lock: unlocked }, { lockedView: 'time' }) })).toBe('clock');
    expect(deskScene({ ...at, desk: desk({ lock: unlocked }, { lockedView: 'time' }) })).toBe('glance');
  });
});

describe('isUnlocked (CG-51)', () => {
  it('is unlocked only while Whombat’s until is ahead', () => {
    expect(isUnlocked(unlocked, SERVER_NOW)).toBe(true);
    expect(isUnlocked(unlocked, SERVER_NOW + 2 * 60_000 - 1)).toBe(true);
    expect(isUnlocked(unlocked, SERVER_NOW + 2 * 60_000)).toBe(false);
    expect(isUnlocked({ ...unlocked, until: null }, SERVER_NOW)).toBe(false);
    expect(isUnlocked({ ...unlocked, until: 'soon' }, SERVER_NOW)).toBe(false);
    expect(isUnlocked({ ...unlocked, state: 'locked' }, SERVER_NOW)).toBe(false);
  });
});

describe('mayListen (CG-52)', () => {
  it('lets the microphone open only in Talk, unlocked, with the voice on and Whombat there', () => {
    const ok = { scene: 'talk' as const, unlocked: true, voice: true, held: false };
    expect(mayListen(ok)).toBe(true);
    expect(mayListen({ ...ok, scene: 'glance' })).toBe(false);
    expect(mayListen({ ...ok, scene: 'night' })).toBe(false);
    expect(mayListen({ ...ok, scene: 'pairing' })).toBe(false);
    expect(mayListen({ ...ok, unlocked: false })).toBe(false);
    expect(mayListen({ ...ok, voice: false })).toBe(false);
    expect(mayListen({ ...ok, held: true })).toBe(false);
  });
});

describe('askShown (CG-50)', () => {
  const plex: DeskAsk = {
    number: 41,
    kind: 'approval',
    title: 'Restart Plex on blackbox?',
    at: '2026-10-20T12:31:00Z',
    where: 'blackbox',
    detail: 'Plex stopped answering.',
    facts: ['docker restart plex'],
    approveLabel: 'Restart Plex',
    onDesk: true,
    phoneReason: null,
  };
  const question: DeskAsk = { ...plex, number: 42, kind: 'question', approveLabel: null };
  const on = { unlocked: true, gone: false, voice: true };

  it('shows an ask’s words and buttons only while unlocked', () => {
    expect(askShown(plex, on)).toEqual({ ask: plex, actions: 'approval', talk: true });
    const locked = askShown(plex, { ...on, unlocked: false });
    expect(locked.actions).toBeNull();
    expect(locked.talk).toBe(false);
    expect(locked.ask).toMatchObject({ number: 41, title: plex.title, where: 'blackbox' });
    expect(locked.ask).toMatchObject({ detail: null, facts: [], approveLabel: null });
    expect(askShown(question, { ...on, unlocked: false }).actions).toBeNull();
  });

  it('gives a question Not now as an approval has it, and Answer only with Talk’s voice', () => {
    expect(askShown(question, on)).toMatchObject({ actions: 'question', talk: true });
    expect(askShown(question, { ...on, voice: false })).toMatchObject({ actions: 'question', talk: false });
    expect(askShown(plex, { ...on, voice: false })).toMatchObject({ actions: 'approval', talk: false });
  });

  it('keeps the phone line and Close, locked or not', () => {
    const phone = { ...plex, onDesk: false, phoneReason: 'outside' as const };
    expect(askShown(phone, on)).toMatchObject({ actions: 'phone', talk: false });
    expect(askShown(phone, { ...on, unlocked: false }).actions).toBe('phone');
    expect(askShown(plex, { ...on, gone: true })).toMatchObject({ actions: 'gone', talk: false });
    expect(askShown(plex, { ...on, unlocked: false, gone: true }).ask.detail).toBeNull();
  });
});

describe('the lock', () => {
  it('counts whole minutes until it locks, at least one', () => {
    const now = Date.parse('2026-10-20T12:34:00Z');
    expect(locksIn('2026-10-20T12:36:00Z', now)).toBe(2);
    expect(locksIn('2026-10-20T12:35:01Z', now)).toBe(2);
    expect(locksIn('2026-10-20T12:34:10Z', now)).toBe(1);
    expect(locksIn('2026-10-20T12:30:00Z', now)).toBe(1);
    expect(locksIn(null, now)).toBeNull();
  });

  it('tells Whombat about touches at most every 20 s, only when unlocked', () => {
    expect(shouldTouch(null, 0, true)).toBe(true);
    expect(shouldTouch(0, TOUCH_EVERY_MS - 1, true)).toBe(false);
    expect(shouldTouch(0, TOUCH_EVERY_MS, true)).toBe(true);
    expect(shouldTouch(null, 0, false)).toBe(false);
  });
});

describe('a new ask (DK-08, DK-09)', () => {
  it('is more asks or one the page hadn’t seen, never the first state', () => {
    expect(newAsk(null, { count: 2, numbers: [] })).toBe(false);
    expect(newAsk({ count: 1, numbers: [] }, { count: 2, numbers: [] })).toBe(true);
    expect(newAsk({ count: 1, numbers: [4] }, { count: 1, numbers: [5] })).toBe(true);
    expect(newAsk({ count: 2, numbers: [4, 5] }, { count: 1, numbers: [5] })).toBe(false);
    // Unlocking shows the titles of asks the page only counted: nothing new.
    expect(newAsk({ count: 2, numbers: [] }, { count: 2, numbers: [4, 5] })).toBe(false);
    expect(newAsk({ count: 7, numbers: [1, 2, 3, 4, 5] }, { count: 7, numbers: [2, 3, 4, 5, 6] })).toBe(
      false,
    );
  });

  it('wakes and chimes by day, does nothing in quiet hours', () => {
    const prev = { count: 0, numbers: [] };
    const next = { count: 1, numbers: [] };
    expect(alertFor(prev, next, false)).toEqual({ wake: true, chime: true });
    expect(alertFor(prev, next, true)).toEqual({ wake: false, chime: false });
  });

  it('draws the amber edge until the next touch while something still needs the person', () => {
    const base = { scene: 'glance' as const, needsYou: 1, sheetOpen: false };
    expect(attention({ ...base, lastInput: 10_000, alertAt: 90_000 }).glow).toBe(true);
    expect(attention({ ...base, lastInput: 95_000, alertAt: 90_000 }).glow).toBe(false);
    expect(attention({ ...base, needsYou: 0, lastInput: 10_000, alertAt: 90_000 }).glow).toBe(false);
    expect(attention({ ...base, sheetOpen: true, lastInput: 95_000, alertAt: null }).glow).toBe(true);
    expect(attention({ ...base, scene: 'night', lastInput: 10_000, alertAt: 90_000 }).glow).toBe(false);
    // The idle clock has its dot instead (DK-70); Talk none.
    expect(attention({ ...base, scene: 'idle', lastInput: 10_000, alertAt: 90_000 }).glow).toBe(false);
    expect(attention({ ...base, scene: 'talk', lastInput: 10_000, alertAt: 90_000 }).glow).toBe(false);
    expect(attention({ ...base, scene: 'clock', lastInput: 10_000, alertAt: 90_000 }).glow).toBe(true);
  });
});

describe('only the clock when nobody’s there (DK-70, DK-71; CG-171)', () => {
  const now = 10_000_000;
  const watching: DeskPresence = { camera: true, watching: true, here: false };
  const at = (lastAgo: number, p: Partial<DeskState> = {}, more: object = {}) =>
    deskScene({
      desk: desk(p),
      now,
      serverNow: SERVER_NOW,
      lastInput: now - lastAgo,
      talkOpen: false,
      ...more,
    });

  it('takes its times from the contracts: 10 minutes, or one with the camera watching', () => {
    expect(deskWordsSource).toContain(`export const DESK_IDLE_S = ${DESK_IDLE_MS / 1000};`);
    expect(deskWordsSource).toContain(`export const DESK_AWAY_S = ${DESK_AWAY_MS / 1000};`);
  });

  it('shows only the clock 10 minutes after the last touch or key, locked or unlocked', () => {
    expect(at(DESK_IDLE_MS - 1)).toBe('glance');
    expect(at(DESK_IDLE_MS)).toBe('idle');
    expect(at(DESK_IDLE_MS, { lock: unlocked })).toBe('idle');
    expect(at(DESK_IDLE_MS, { lock: { ...unlocked, stays: true } })).toBe('idle');
    // “Only the time” locked: the idle clock instead of the clock with its line.
    expect(
      deskScene({
        desk: desk({}, { lockedView: 'time' }),
        now,
        serverNow: SERVER_NOW,
        lastInput: now - DESK_IDLE_MS,
        talkOpen: false,
      }),
    ).toBe('idle');
  });

  it('goes after a minute while the camera can tell nobody is there, 10 when it can’t', () => {
    expect(at(DESK_AWAY_MS - 1, { presence: watching })).toBe('glance');
    expect(at(DESK_AWAY_MS, { presence: watching })).toBe('idle');
    // Starting, too dark or failed: the 10 minutes hold.
    const dark = { ...watching, watching: false };
    expect(at(DESK_AWAY_MS, { presence: dark })).toBe('glance');
    expect(at(DESK_IDLE_MS, { presence: dark })).toBe('idle');
  });

  it('keeps the glance while the camera sees someone, however long since the last touch', () => {
    const here = { ...watching, here: true };
    expect(at(DESK_IDLE_MS * 6, { presence: here })).toBe('glance');
    expect(at(DESK_IDLE_MS * 6, { presence: { ...here, watching: false } })).toBe('glance');
    // A face never unlocks (DK-29): the locked glance, or “Only the time” as a touch would show it.
    expect(
      deskScene({
        desk: desk({ presence: here }, { lockedView: 'time' }),
        now,
        serverNow: SERVER_NOW,
        lastInput: 0,
        talkOpen: false,
      }),
    ).toBe('clock');
  });

  it('keeps the glance up 10 minutes after a new ask, even with nobody seen', () => {
    expect(at(DESK_IDLE_MS, { presence: watching }, { alertAt: now - DESK_IDLE_MS + 1 })).toBe('glance');
    expect(at(DESK_IDLE_MS, { presence: watching }, { alertAt: now - DESK_IDLE_MS })).toBe('idle');
  });

  it('never goes while Talk is in use or the phone is asked to unlock', () => {
    expect(at(DESK_IDLE_MS, { lock: unlocked }, { talkOpen: true, talkBusy: true })).toBe('talk');
    expect(at(DESK_IDLE_MS, {}, { talkBusy: true })).toBe('glance');
    // A Talk that has finished goes with it.
    expect(at(DESK_IDLE_MS, { lock: unlocked }, { talkOpen: true })).toBe('idle');
    const phone = { state: 'phone', until: null, retryAt: null, expiresAt: '2026-10-20T12:36:00Z' } as const;
    expect(at(DESK_IDLE_MS, { lock: phone })).toBe('glance');
    expect(
      at(DESK_IDLE_MS, {
        lock: { state: 'backoff', until: null, retryAt: '2026-10-20T12:35:00Z', expiresAt: null },
      }),
    ).toBe('idle');
  });

  it('leaves quiet hours and the pairing letters as they are', () => {
    const quiet = (p: Partial<DeskState>, more: object = {}) =>
      deskScene({
        desk: desk(p, { quiet: true }),
        now,
        serverNow: SERVER_NOW,
        lastInput: now - DESK_IDLE_MS,
        talkOpen: false,
        ...more,
      });
    expect(quiet({})).toBe('night');
    expect(quiet({ presence: watching }, { idleSince: 0 })).toBe('night');
    expect(at(DESK_IDLE_MS, { pairing: { code: 'HBRT', expiresAt: '' } })).toBe('pairing');
    expect(
      isIdle({
        desk: desk({ paired: null }),
        now,
        serverNow: SERVER_NOW,
        lastInput: 0,
        talkOpen: false,
      }),
    ).toBe(false);
  });

  it('stays until a touch, a key, a face or a new ask wakes it, not when the camera stops telling', () => {
    const since = now - 5000;
    const idle = (lastAgo: number, presence: DeskPresence | undefined, more: object = {}) =>
      at(lastAgo, { presence }, { idleSince: since, ...more });
    expect(idle(DESK_AWAY_MS, watching)).toBe('idle');
    // Too dark now: 10 minutes would say glance, but nothing woke it.
    expect(idle(DESK_AWAY_MS, { ...watching, watching: false })).toBe('idle');
    expect(idle(DESK_AWAY_MS, undefined)).toBe('idle');
    expect(idle(0, watching)).toBe('glance');
    expect(idle(4000, watching)).toBe('glance');
    expect(idle(DESK_AWAY_MS, { ...watching, here: true })).toBe('glance');
    expect(idle(DESK_AWAY_MS, watching, { alertAt: now - 1000 })).toBe('glance');
  });

  it('only wakes on the first touch, as at night', () => {
    expect(wakesOnly('idle')).toBe(true);
    expect(wakesOnly('night')).toBe(true);
    expect(wakesOnly('black')).toBe(true);
    expect(wakesOnly('glance')).toBe(false);
    expect(wakesOnly('clock')).toBe(false);
  });
});

describe('nightLine', () => {
  it('says all fine or something needs you — never a name; a server down needs you too', () => {
    expect(nightLine(glance())).toBe('fine');
    expect(nightLine(glance(2))).toBe('needsYou');
    expect(nightLine(glance(0, true))).toBe('needsYou');
    expect(nightLine(null)).toBe('fine');
  });
});

describe('continueTalk', () => {
  it('follows on within 2 minutes, not for a new topic (an ask’s Ask button)', () => {
    expect(continueTalk(null, 0, false)).toBe(false);
    expect(continueTalk(0, 119_000, false)).toBe(true);
    expect(continueTalk(0, 121_000, false)).toBe(false);
    expect(continueTalk(0, 10_000, true)).toBe(false);
  });

  it('counts from the answer: an 80 s answer and a question 50 s later follow on (CG-54)', () => {
    const sent = 0;
    const answered = 80_000;
    expect(continueTalk(sent, answered + 50_000, false)).toBe(false);
    expect(continueTalk(answered, answered + 50_000, false)).toBe(true);
  });
});

describe('the screens a card opens (DK-83…DK-87, CG-256)', () => {
  const NOW = 1_000_000_000;
  const scene = (d: DeskState, o: Partial<Parameters<typeof deskScene>[0]> = {}) =>
    deskScene({ desk: d, now: NOW, serverNow: SERVER_NOW, lastInput: NOW, talkOpen: false, ...o });

  it('opens on a locked screen too, and touching it there opens the PIN pad but a card doesn’t (DK-84)', () => {
    for (const page of ['server', 'servers', 'self'] as const) {
      expect(scene(desk(), { page })).toBe(page);
      expect(scene(desk({ lock: unlocked }), { page })).toBe(page);
      expect(touchUnlocks(page)).toBe(true);
    }
    expect(touchUnlocks('glance')).toBe(true);
    expect(touchUnlocks('talk')).toBe(false);
  });

  it('goes back to the glance two minutes after the last touch (DK-83)', () => {
    expect(scene(desk(), { page: 'server', lastInput: NOW - PAGE_MS + 1 })).toBe('server');
    expect(scene(desk(), { page: 'server', lastInput: NOW - PAGE_MS })).toBe('glance');
    expect(pageKept('glance', 'server')).toBe(false);
  });

  it('has no screen in “Only the time” while locked: the clock, and the screen closes (DK-84)', () => {
    const time = desk({}, { lockedView: 'time' });
    expect(scene(time, { page: 'server' })).toBe('clock');
    expect(pageKept('clock', 'server')).toBe(false);
    // Unlocked, “Only the time” doesn't apply.
    expect(scene(desk({ lock: unlocked }, { lockedView: 'time' }), { page: 'server' })).toBe('server');
  });

  it('keeps the screen under Talk (Ask about this server, DK-85); the night and the idle clock close it', () => {
    expect(scene(desk({ lock: unlocked }), { page: 'server', talkOpen: true })).toBe('talk');
    expect(pageKept('talk', 'server')).toBe(true);
    const quiet = desk({}, { quiet: true });
    expect(scene(quiet, { page: 'server', lastInput: NOW - SHOW_MS })).toBe('night');
    expect(pageKept('night', 'server')).toBe(false);
    expect(pageKept('idle', 'self')).toBe(false);
    expect(
      scene(desk({ pairing: { code: 'HBRT', expiresAt: '2026-10-20T12:40:00Z' } }), { page: 'server' }),
    ).toBe('pairing');
  });

  it('lets an ask and the PIN pad open over it as over the glance (DK-60), and the amber edge show', () => {
    for (const s of ['server', 'servers', 'self', 'glance', 'clock', 'talk'] as const)
      expect(sheetOver(s)).toBe(true);
    for (const s of ['night', 'black', 'idle', 'pairing'] as const) expect(sheetOver(s)).toBe(false);
    expect(attention({ scene: 'server', lastInput: 0, alertAt: 5, needsYou: 1, sheetOpen: false }).glow).toBe(
      true,
    );
  });
});
