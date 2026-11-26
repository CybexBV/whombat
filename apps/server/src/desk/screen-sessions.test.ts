import {
  DESK_TRIES,
  type DeskCalm,
  type DeskCalmView,
  type DeskGrid,
  deskDefaultLayout,
  deskPinBackoffS,
  deskTriesLeft,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { SessionOpError } from '../managed/session-error';
import {
  SCREEN_SEEN_EVERY_MS,
  SCREEN_SIZE_EVERY_MS,
  SCREEN_UNLOCK_IDLE_MS,
  SCREEN_UNLOCK_MAX_MS,
  type ScreenLockSettings,
  ScreenSessions,
} from './screen-sessions';
import type { ScreenRecord, ScreensApi } from './widgets/types';

const T0 = Date.parse('2026-10-27T12:00:00.000Z');
const SIZE = { width: 1180, height: 820 };
const PIN = '2580';

const KITCHEN: ScreenRecord = {
  id: 'scr_kitchen01',
  burrowId: 'brw_1',
  kind: 'device',
  name: 'Kitchen',
  popups: 'problems',
  doorbell: 'big',
  layout: deskDefaultLayout(),
  show: {} as ScreenRecord['show'],
  endpointId: 'ep_tablet',
  personId: 'prn_mara',
  device: 'iOS · Safari',
  size: null,
  lastSeenAt: null,
};

/** The store as the screen ops see it: what it was asked to draw and keep. */
class FakeScreens implements ScreensApi {
  draws: DeskCalmView[] = [];
  pictures: { view: DeskCalmView; thing: string; ref: string }[] = [];
  sizes: { id: string; size: { width: number; height: number } }[] = [];
  headline = 'All fine';
  picture_: { type: string; bytes: Uint8Array } | null = {
    type: 'image/jpeg',
    bytes: new Uint8Array([1, 2, 3]),
  };

  async list() {
    return [KITCHEN];
  }
  async get() {
    return KITCHEN;
  }
  async byEndpoint() {
    return KITCHEN;
  }
  async addDevice(): Promise<ScreenRecord> {
    throw new Error('not here');
  }
  async seen(id: string, size: { width: number; height: number }) {
    this.sizes.push({ id, size });
  }
  async draw(screen: ScreenRecord, view: DeskCalmView) {
    this.draws.push(view);
    return {
      calm: { headline: { text: this.headline } } as unknown as DeskCalm,
      grid: { screen: screen.id, views: [], view } as unknown as DeskGrid,
    };
  }
  async picture(_screen: ScreenRecord, view: DeskCalmView, thing: string, ref: string) {
    this.pictures.push({ view, thing, ref });
    return this.picture_;
  }
  zone: string | null = 'Europe/Amsterdam';
  async timeZone() {
    return this.zone;
  }
}

/**
 * The box's lock as the desk keeps it (one count of wrong PINs for the box and every screen) and its check, as
 * `DeskService.checkScreenPin` answers: the real one is tested with the database (`managed/display.int.test.ts`).
 */
function setup(settings: Partial<ScreenLockSettings> = {}) {
  const api = new FakeScreens();
  const clock = { now: T0 };
  const lock: ScreenLockSettings = {
    view: 'summary',
    pinHash: 'hash-of-2580',
    wrongPins: 0,
    retryAt: null,
    ...settings,
  };
  const checked: string[] = [];
  const sessions = new ScreenSessions({
    api,
    clock: () => clock.now,
    lockSettings: async () => ({ ...lock }),
    whombatName: async () => 'Home',
    checkPin: async (pin) => {
      checked.push(pin);
      if (lock.retryAt !== null && lock.retryAt > clock.now)
        return { result: 'backoff', retryAt: lock.retryAt };
      if (pin === PIN && lock.pinHash) {
        lock.wrongPins = 0;
        lock.retryAt = null;
        return { result: 'right', pinHash: lock.pinHash };
      }
      lock.wrongPins += 1;
      const wait = deskPinBackoffS(lock.wrongPins) * 1000;
      if (wait > 0) {
        lock.retryAt = clock.now + wait;
        return { result: 'backoff', retryAt: lock.retryAt };
      }
      return { result: 'wrong', triesLeft: deskTriesLeft(lock.wrongPins) };
    },
  });
  return { api, clock, lock, sessions, checked };
}

async function stateOf(sessions: ScreenSessions, known?: string) {
  const out = await sessions.state(KITCHEN, { size: SIZE, ...(known ? { known } : {}) });
  if ('same' in out) throw new Error('expected a state');
  return out;
}

describe('a screen elsewhere’s state', () => {
  it('draws locked as the box’s lock says, with its own name and the Whombat’s', async () => {
    const { api, sessions } = setup();
    const state = await stateOf(sessions);
    expect(state).toMatchObject({
      screen: { id: KITCHEN.id, name: 'Kitchen', popups: 'problems' },
      whombat: 'Home',
      lock: { state: 'locked', view: 'summary', hasPin: true },
      now: new Date(T0).toISOString(),
    });
    expect(api.draws).toEqual(['summary']);
    expect(state.etag).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('tells the screen the person’s time zone, for its clock and its pages by time of day', async () => {
    const { api, sessions } = setup({ view: 'time' });
    expect((await stateOf(sessions)).timeZone).toBe('Europe/Amsterdam');
    api.zone = null;
    expect((await stateOf(sessions)).timeZone).toBeUndefined();
  });

  it('*Only the time* draws nothing at all', async () => {
    const { api, sessions } = setup({ view: 'time' });
    const state = await stateOf(sessions);
    expect(state).toMatchObject({ calm: null, grid: null, lock: { view: 'time' } });
    expect(api.draws).toEqual([]);
  });

  it('answers {same} when nothing changed, whatever the time, and everything when something did', async () => {
    const { api, clock, sessions } = setup();
    const first = await stateOf(sessions);
    clock.now += 10_000;
    expect(await sessions.state(KITCHEN, { size: SIZE, known: first.etag })).toEqual({
      same: true,
      etag: first.etag,
    });
    api.headline = 'Plex is down';
    const changed = await sessions.state(KITCHEN, { size: SIZE, known: first.etag });
    expect('same' in changed).toBe(false);
    expect(changed.etag).not.toBe(first.etag);
  });

  it('keeps its size at most every 30 s when it changes, else once a minute, without waiting for it', async () => {
    const { api, clock, sessions } = setup();
    await stateOf(sessions);
    clock.now += 10_000;
    await stateOf(sessions);
    expect(api.sizes).toHaveLength(1);
    // A size flipping back and forth is written at most every 30 s.
    await sessions.state(KITCHEN, { size: { width: 820, height: 1180 } });
    await sessions.state(KITCHEN, { size: SIZE });
    expect(api.sizes).toHaveLength(1);
    clock.now += SCREEN_SIZE_EVERY_MS;
    await sessions.state(KITCHEN, { size: { width: 820, height: 1180 } });
    expect(api.sizes.map((s) => s.size.width)).toEqual([1180, 820]);
    clock.now += SCREEN_SEEN_EVERY_MS;
    await sessions.state(KITCHEN, { size: { width: 820, height: 1180 } });
    expect(api.sizes).toHaveLength(3);
  });
});

describe('a screen elsewhere’s lock', () => {
  it('the box’s PIN unlocks it: everything shows, and asking keeps it unlocked until two minutes after', async () => {
    const { api, clock, sessions } = setup();
    expect(await sessions.unlock(KITCHEN, PIN)).toMatchObject({
      state: 'unlocked',
      until: new Date(T0 + SCREEN_UNLOCK_IDLE_MS).toISOString(),
    });
    clock.now += 90_000;
    expect((await stateOf(sessions)).lock).toMatchObject({
      state: 'unlocked',
      until: new Date(clock.now + SCREEN_UNLOCK_IDLE_MS).toISOString(),
    });
    expect(api.draws).toEqual(['everything']);
    // Nobody asks for two minutes: locked again.
    clock.now += SCREEN_UNLOCK_IDLE_MS;
    expect((await stateOf(sessions)).lock.state).toBe('locked');
    expect(api.draws.at(-1)).toBe('summary');
  });

  it('never stays unlocked longer than half an hour, however much it is used', async () => {
    const { clock, sessions } = setup();
    await sessions.unlock(KITCHEN, PIN);
    for (let t = 0; t < SCREEN_UNLOCK_MAX_MS; t += 10_000) {
      clock.now = T0 + t;
      await stateOf(sessions);
    }
    clock.now = T0 + SCREEN_UNLOCK_MAX_MS;
    expect((await stateOf(sessions)).lock.state).toBe('locked');
  });

  it('locks at once when asked, and when the box’s PIN changed or went', async () => {
    const { lock, sessions } = setup();
    await sessions.unlock(KITCHEN, PIN);
    expect((await sessions.lock(KITCHEN)).state).toBe('locked');
    await sessions.unlock(KITCHEN, PIN);
    lock.pinHash = 'hash-of-another';
    expect((await stateOf(sessions)).lock.state).toBe('locked');
    lock.pinHash = null;
    expect((await stateOf(sessions)).lock).toMatchObject({ state: 'locked', hasPin: false });
  });

  it('can’t be unlocked without a PIN on the box', async () => {
    const { sessions } = setup({ pinHash: null });
    const err = await sessions.unlock(KITCHEN, PIN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionOpError);
    expect((err as SessionOpError).details).toMatchObject({ code: 'no_pin' });
  });

  it('five wrong PINs make it wait, without even checking what is typed meanwhile; then the right one unlocks', async () => {
    const { clock, sessions, checked } = setup();
    for (let i = 1; i < DESK_TRIES; i++)
      expect(await sessions.unlock(KITCHEN, '1111')).toMatchObject({
        state: 'locked',
        triesLeft: DESK_TRIES - i,
      });
    expect(await sessions.unlock(KITCHEN, '1111')).toMatchObject({
      state: 'backoff',
      retryAt: new Date(T0 + 60_000).toISOString(),
      triesLeft: 0,
    });
    // The right PIN while it waits isn't even checked; the state says it waits.
    expect(await sessions.unlock(KITCHEN, PIN)).toMatchObject({ state: 'backoff' });
    expect(checked).toHaveLength(DESK_TRIES);
    expect((await stateOf(sessions)).lock).toMatchObject({ state: 'backoff', triesLeft: 0 });
    clock.now += 60_000;
    expect((await sessions.unlock(KITCHEN, PIN)).state).toBe('unlocked');
  });

  it('PINs asked all at once are checked one at a time, so they guess no faster', async () => {
    const { sessions, checked } = setup();
    const answers = await Promise.all(Array.from({ length: 20 }, () => sessions.unlock(KITCHEN, '1111')));
    expect(checked).toHaveLength(DESK_TRIES);
    expect(answers.filter((a) => a.state === 'backoff')).toHaveLength(20 - DESK_TRIES + 1);
  });

  it('the box’s count and wait hold on every screen: wrong PINs elsewhere add up, and nothing is checked while it waits', async () => {
    const { lock, sessions, checked } = setup({ wrongPins: 3 });
    const office = { ...KITCHEN, id: 'scr_office001', endpointId: 'ep_office' };
    // Three wrong at the box already: two more on two screens make everything wait.
    expect((await stateOf(sessions)).lock).toMatchObject({ state: 'locked', triesLeft: DESK_TRIES - 3 });
    expect(await sessions.unlock(KITCHEN, '1111')).toMatchObject({ triesLeft: 1 });
    expect((await sessions.unlock(office, '1111')).state).toBe('backoff');
    expect((await sessions.unlock(KITCHEN, PIN)).state).toBe('backoff');
    expect(checked).toEqual(['1111', '1111']);
    // The box waits for a reason of its own (wrong PINs typed on it): so do the screens.
    lock.retryAt = T0 + 3_600_000;
    expect((await sessions.unlock(office, PIN)).state).toBe('backoff');
    expect(checked).toHaveLength(2);
  });
});

describe('a screen elsewhere’s pictures', () => {
  it('asks the store under the lock it has now', async () => {
    const { api, sessions } = setup();
    expect(await sessions.image(KITCHEN, { thing: 'connection:plex', ref: 'abcdefghijklmnop.sig' })).toEqual({
      type: 'image/jpeg',
      data: 'AQID',
    });
    await sessions.unlock(KITCHEN, PIN);
    await sessions.image(KITCHEN, { thing: 'connection:plex', ref: 'abcdefghijklmnop.sig' });
    expect(api.pictures.map((p) => p.view)).toEqual(['summary', 'everything']);
  });

  it('refuses every way alike: *Only the time*, none, an odd type', async () => {
    const input = { thing: 'connection:plex', ref: 'abcdefghijklmnop.sig' };
    const time = setup({ view: 'time' });
    const none = setup();
    none.api.picture_ = null;
    const odd = setup();
    odd.api.picture_ = { type: 'image/svg+xml', bytes: new Uint8Array([60]) };
    const refusals = await Promise.all(
      [time, none, odd].map((s) =>
        s.sessions.image(KITCHEN, input).catch((e: { code?: string; message?: string }) => e),
      ),
    );
    expect(new Set(refusals.map((r) => `${(r as { code: string }).code}:${(r as Error).message}`)).size).toBe(
      1,
    );
    expect((refusals[0] as { code: string }).code).toBe('not_found');
    expect(time.api.pictures).toEqual([]);
  });
});
