import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../config';
import { DeskLock, PRESENCE_GONE_MS, PRESENCE_KEEP_MS, PRESENCE_MAX_MS, UNLOCK_IDLE_MS } from './lock';
import {
  type CameraWantInput,
  CONSOLE_ASKED_MS,
  cameraWant,
  NO_PRESENCE,
  PRESENCE_AWAY_MS,
  PRESENCE_CHECK_MS,
  PRESENCE_WATCH_TIMEOUT_MS,
  PresenceCallError,
  PresenceLoop,
  type PresencePort,
  PresenceSocketClient,
  presenceFor,
  presenceHealth,
  setPresenceFor,
} from './presence';
import { FakePresence, type FakePresenceServer, startFakePresence } from './testing/fake-presence';
import { fakeTime } from './testing/fake-time';

/**
 * The lock, the loop and the fake on one clock. By default an unlocked screen with the camera watching for DK-28's case;
 * `wants` says what wants the camera (DK-28's case keeps the unlock that is the screen's now, DK-72's is the clock).
 */
function desk(o: { unlocked?: boolean; lock?: boolean; clock?: boolean } = {}) {
  const time = fakeTime();
  const fake = new FakePresence(() => time.now);
  const lock = new DeskLock();
  const warned: string[] = [];
  const wants = { lock: o.lock ?? true, clock: o.clock ?? false };
  const loop = new PresenceLoop({
    lock,
    now: () => time.now,
    after: time.after,
    port: () => fake,
    wanted: () => ({ lock: wants.lock ? lock.epoch : null, clock: wants.clock }),
    warn: (message) => warned.push(message),
  });
  const unlockedAt = time.now;
  if (o.unlocked ?? true) lock.unlock(time.now);
  loop.poke();
  return { time, fake, lock, loop, unlockedAt, warned, wants };
}

describe('staying unlocked while you’re here (DK-28)', () => {
  it('stays unlocked while it sees a face, and locks 30 s after the last one, the camera off at once', async () => {
    const { time, fake, lock, unlockedAt } = desk();
    await time.advance(0);
    // The camera is opening: no frame yet, DK-04's 2 minutes.
    expect(lock.view(time.now, null)).toEqual({
      state: 'unlocked',
      until: unlockedAt + UNLOCK_IDLE_MS,
      camera: true,
    });
    await time.advance(10 * 60_000);
    expect(lock.unlocked(time.now)).toBe(true);
    const here = lock.view(time.now, null);
    expect(here).toMatchObject({ state: 'unlocked', camera: true, present: true });
    expect((here.until as number) - time.now).toBeLessThanOrEqual(PRESENCE_GONE_MS);
    fake.someone = false;
    const lastFace = time.now;
    await time.advance(PRESENCE_GONE_MS - 1);
    // Someone was there within the 30 s: still “stays unlocked while you’re here”.
    expect(lock.view(time.now, null)).toMatchObject({ state: 'unlocked', camera: true, present: true });
    await time.advance(1);
    expect(time.now).toBe(lastFace + PRESENCE_GONE_MS);
    expect(lock.unlocked(time.now)).toBe(false);
    expect(fake.calls.at(-1)).toBe('stop');
    expect(fake.cameraOn()).toBe(false);
  });

  it('keeps DK-04’s 2 minutes until it has seen a face, a touch as before', async () => {
    const { time, fake, lock, loop, unlockedAt } = desk();
    fake.someone = false;
    await time.advance(100_000);
    expect(lock.touch(time.now)).toBe(time.now + UNLOCK_IDLE_MS);
    const touched = time.now;
    await time.advance(UNLOCK_IDLE_MS - 1);
    expect(lock.unlocked(time.now)).toBe(true);
    await time.advance(1);
    expect(time.now).toBe(touched + UNLOCK_IDLE_MS);
    expect(time.now).toBeGreaterThan(unlockedAt + UNLOCK_IDLE_MS);
    expect(lock.unlocked(time.now)).toBe(false);
    expect(loop.running).toBe(false);
    expect(fake.calls.at(-1)).toBe('stop');
  });

  it('goes back to 2 minutes after the last face when the picture turns dark or the camera fails', async () => {
    for (const picture of ['dark', 'failed'] as const) {
      const { time, fake, lock } = desk();
      await time.advance(PRESENCE_CHECK_MS * 3);
      const lastFace = time.now;
      fake.picture = picture;
      await time.advance(PRESENCE_CHECK_MS);
      // Dark: the camera is still on, it just can't tell; failed: it closed.
      expect(lock.view(time.now, null)).toEqual({
        state: 'unlocked',
        until: lastFace + UNLOCK_IDLE_MS,
        ...(picture === 'dark' ? { camera: true } : {}),
      });
      await time.advance(lastFace + UNLOCK_IDLE_MS - time.now - 1);
      expect(lock.unlocked(time.now)).toBe(true);
      await time.advance(1);
      expect(lock.unlocked(time.now)).toBe(false);
      expect(fake.calls.at(-1)).toBe('stop');
    }
  });

  it('gives a picture back from dark its 30 s from then', async () => {
    const { time, fake, lock } = desk();
    await time.advance(PRESENCE_CHECK_MS);
    fake.picture = 'dark';
    await time.advance(PRESENCE_CHECK_MS * 30);
    fake.picture = 'watching';
    fake.someone = false;
    await time.advance(PRESENCE_CHECK_MS);
    const back = time.now;
    expect(lock.untilAt()).toBe(back + PRESENCE_GONE_MS);
    fake.someone = true;
    await time.advance(PRESENCE_CHECK_MS);
    expect(lock.view(time.now, null).present).toBe(true);
  });

  it('locks after 4 hours in a row though someone is there; a touch in its last 2 minutes keeps DK-04’s rule', async () => {
    const a = desk();
    await a.time.advance(PRESENCE_MAX_MS - 1);
    expect(a.lock.unlocked(a.time.now)).toBe(true);
    await a.time.advance(1);
    expect(a.time.now).toBe(a.unlockedAt + PRESENCE_MAX_MS);
    expect(a.lock.unlocked(a.time.now)).toBe(false);
    expect(a.fake.calls.at(-1)).toBe('stop');

    const b = desk();
    await b.time.advance(PRESENCE_MAX_MS - 60_000);
    b.lock.touch(b.time.now);
    const touched = b.time.now;
    await b.time.advance(60_000);
    // The 4 hours are up: the camera is off, the touch keeps its 2 minutes.
    expect(b.lock.view(b.time.now, null)).toEqual({ state: 'unlocked', until: touched + UNLOCK_IDLE_MS });
    expect(b.loop.running).toBe(false);
    expect(b.fake.cameraOn()).toBe(false);
    await b.time.advance(UNLOCK_IDLE_MS - 60_000);
    expect(b.lock.unlocked(b.time.now)).toBe(false);
  });

  it('sends stop at once when stopped, and drops what a watch still on its way saw', async () => {
    const { time, fake, lock, loop } = desk();
    await time.advance(PRESENCE_CHECK_MS * 2);
    fake.hold();
    await time.advance(PRESENCE_CHECK_MS);
    const until = lock.untilAt();
    loop.stop();
    lock.lock();
    expect(fake.calls.at(-1)).toBe('stop');
    fake.release();
    await time.advance(0);
    // That watch may have opened the camera after the stop: stop again.
    expect(fake.calls.slice(-3)).toEqual(['watch', 'stop', 'stop']);
    expect(lock.unlocked(time.now)).toBe(false);
    expect(until).toBeGreaterThan(time.now);
  });

  it('never keeps it longer than DK-04 when the service is slow or failing', async () => {
    const { time, fake, lock, warned } = desk();
    await time.advance(PRESENCE_CHECK_MS * 2);
    const lastFace = time.now;
    fake.hold();
    await time.advance(PRESENCE_CHECK_MS + PRESENCE_WATCH_TIMEOUT_MS);
    expect(lock.untilAt()).toBe(lastFace + UNLOCK_IDLE_MS);
    expect(warned).toHaveLength(1);
    fake.release();
    fake.failNext = new PresenceCallError('unavailable', 'gone');
    await time.advance(PRESENCE_CHECK_MS * 2);
    expect(warned).toHaveLength(1);
    // Answers again: the camera keeps it as before.
    expect(lock.view(time.now, null).present).toBe(true);
    // A service that stops answering keeps the camera mark only as long as the service would keep the camera.
    fake.hold();
    await time.advance(PRESENCE_KEEP_MS + PRESENCE_CHECK_MS);
    expect(lock.view(time.now, null).camera).toBeUndefined();
  });

  it('starts only for the unlock it was asked for', async () => {
    const time = fakeTime();
    const fake = new FakePresence(() => time.now);
    const lock = new DeskLock();
    let epoch: number | null = null;
    const loop = new PresenceLoop({
      lock,
      now: () => time.now,
      after: time.after,
      port: () => fake,
      wanted: () => ({ lock: epoch, clock: false }),
      warn: () => {},
    });
    lock.unlock(time.now);
    epoch = lock.epoch;
    lock.lock();
    loop.poke();
    await time.advance(PRESENCE_CHECK_MS);
    expect(loop.running).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it('stops watching for an unlock that stays (DK-74), and starts at once when it doesn’t any more', async () => {
    const { time, fake, lock, loop } = desk();
    await time.advance(PRESENCE_CHECK_MS);
    lock.stay(true, time.now);
    loop.poke();
    expect(loop.running).toBe(false);
    expect(fake.calls.at(-1)).toBe('stop');
    expect(lock.view(time.now, null)).toEqual({
      state: 'unlocked',
      until: time.now + UNLOCK_IDLE_MS,
      stays: true,
    });
    await time.advance(PRESENCE_MAX_MS);
    expect(lock.unlocked(time.now)).toBe(true);
    // Back to *When you leave*: the change is the unlock, as a touch, and the camera looks at once.
    const changed = time.now;
    lock.stay(false, changed);
    loop.poke();
    await time.advance(0);
    expect(fake.calls.at(-1)).toBe('watch');
    expect(loop.keeping).toBe(lock.epoch);
    await time.advance(PRESENCE_CHECK_MS * 3);
    expect(lock.view(time.now, null)).toMatchObject({ state: 'unlocked', camera: true, present: true });
    expect(lock.presenceEndsAt()).toBe(changed + PRESENCE_MAX_MS);
  });
});

describe('the camera for the clock (DK-72, DK-73)', () => {
  it('looks while locked and says someone is here until a minute after the last face; a face never unlocks', async () => {
    const { time, fake, lock, loop } = desk({ unlocked: false, lock: false, clock: true });
    expect(loop.running).toBe(true);
    await time.advance(0);
    // Opening: on, but it can't tell yet.
    expect(loop.presence(time.now)).toEqual({ camera: true, watching: false, here: false });
    await time.advance(PRESENCE_CHECK_MS);
    expect(loop.presence(time.now)).toEqual({ camera: true, watching: true, here: true });
    expect(lock.view(time.now, null)).toEqual({ state: 'locked' });
    fake.someone = false;
    const lastFace = time.now;
    await time.advance(PRESENCE_AWAY_MS - 1);
    expect(loop.presence(time.now)).toEqual({ camera: true, watching: true, here: true });
    await time.advance(1);
    expect(time.now - lastFace).toBe(PRESENCE_AWAY_MS);
    expect(loop.presence(time.now)).toEqual({ camera: true, watching: true, here: false });
    expect(fake.calls).not.toContain('stop');
    expect(lock.unlocked(time.now)).toBe(false);
  });

  it('can’t tell while the picture is dark, the camera failed or the service doesn’t answer', async () => {
    const { time, fake, loop } = desk({ unlocked: false, lock: false, clock: true });
    await time.advance(PRESENCE_CHECK_MS);
    fake.picture = 'dark';
    await time.advance(PRESENCE_CHECK_MS);
    expect(loop.presence(time.now)).toMatchObject({ camera: true, watching: false });
    fake.picture = 'failed';
    await time.advance(PRESENCE_CHECK_MS);
    expect(loop.presence(time.now)).toMatchObject({ camera: false, watching: false });
    fake.picture = 'watching';
    await time.advance(PRESENCE_CHECK_MS);
    expect(loop.presence(time.now)).toEqual({ camera: true, watching: true, here: true });
    // No answer: it can't tell at once; the camera mark lasts as long as the service would keep the camera.
    fake.hold();
    await time.advance(PRESENCE_CHECK_MS + PRESENCE_WATCH_TIMEOUT_MS);
    expect(loop.presence(time.now)).toMatchObject({ camera: true, watching: false });
    await time.advance(PRESENCE_KEEP_MS);
    expect(loop.presence(time.now).camera).toBe(false);
  });

  it('doesn’t turn the camera off and on at an unlock or a lock while the clock wants it', async () => {
    const { time, fake, lock, loop, wants } = desk({ unlocked: false, lock: true, clock: true });
    await time.advance(PRESENCE_CHECK_MS * 2);
    expect(loop.keeping).toBeNull();
    lock.unlock(time.now);
    loop.poke();
    expect(loop.keeping).toBe(lock.epoch);
    await time.advance(PRESENCE_CHECK_MS * 2);
    expect(lock.view(time.now, null)).toMatchObject({ state: 'unlocked', camera: true, present: true });
    lock.lock();
    loop.poke();
    expect(loop.keeping).toBeNull();
    await time.advance(PRESENCE_CHECK_MS);
    expect(fake.calls).not.toContain('stop');
    expect(fake.cameraOn()).toBe(true);
    expect(loop.presence(time.now).here).toBe(true);
    // Nothing wants it any more: off at once.
    wants.clock = false;
    loop.poke();
    expect(loop.running).toBe(false);
    expect(fake.calls.at(-1)).toBe('stop');
    expect(loop.presence(time.now)).toEqual({ camera: false, watching: false, here: false });
  });

  it('feeds the lock only in DK-28’s case: with the clock alone a face keeps no unlock', async () => {
    const { time, lock, loop, unlockedAt } = desk({ unlocked: true, lock: false, clock: true });
    await time.advance(UNLOCK_IDLE_MS);
    expect(time.now).toBe(unlockedAt + UNLOCK_IDLE_MS);
    expect(lock.unlocked(time.now)).toBe(false);
    expect(loop.running).toBe(true);
    expect(loop.presence(time.now).here).toBe(true);
  });

  it('with both, locks 30 s after the last face and keeps looking for the clock', async () => {
    const { time, fake, lock, loop } = desk({ unlocked: true, lock: true, clock: true });
    await time.advance(PRESENCE_CHECK_MS * 3);
    expect(lock.view(time.now, null).present).toBe(true);
    fake.someone = false;
    const lastFace = time.now;
    await time.advance(PRESENCE_GONE_MS);
    expect(lock.unlocked(time.now)).toBe(false);
    expect(time.now - lastFace).toBe(PRESENCE_GONE_MS);
    expect(loop.running).toBe(true);
    expect(loop.keeping).toBeNull();
    expect(fake.calls).not.toContain('stop');
    expect(loop.presence(time.now)).toEqual({ camera: true, watching: true, here: true });
  });

  it('gives the lock only answers to watches sent for its own unlock', async () => {
    const { time, fake, lock, loop } = desk({ unlocked: false, lock: true, clock: true });
    await time.advance(PRESENCE_CHECK_MS);
    fake.hold();
    await time.advance(PRESENCE_CHECK_MS);
    lock.unlock(time.now);
    loop.poke();
    fake.release();
    await time.advance(0);
    // The clock heard it; the lock didn't: that watch was asked before this unlock.
    expect(loop.presence(time.now).here).toBe(true);
    expect(lock.view(time.now, null)).toEqual({ state: 'unlocked', until: time.now + UNLOCK_IDLE_MS });
    await time.advance(PRESENCE_CHECK_MS);
    expect(lock.view(time.now, null)).toMatchObject({ camera: true, present: true });
  });

  it('re-checks what wants it at every check, and stops when nothing does', async () => {
    const { time, fake, loop, wants } = desk({ unlocked: false, lock: false, clock: true });
    await time.advance(PRESENCE_CHECK_MS * 2);
    wants.clock = false;
    const asked = fake.calls.length;
    await time.advance(PRESENCE_CHECK_MS);
    expect(loop.running).toBe(false);
    expect(fake.calls.slice(asked)).toEqual(['stop']);
    // Nothing wants it: a poke starts nothing.
    loop.poke();
    expect(loop.running).toBe(false);
  });
});

describe('what wants the camera (DK-S70)', () => {
  const noon = Date.parse('2026-10-20T12:00:00.000Z');
  const input = (o: Partial<CameraWantInput> = {}, settings: Partial<CameraWantInput['settings']> = {}) =>
    ({
      settings: {
        presence: false,
        stayUnlocked: false,
        cameraWake: true,
        quietHours: { enabled: true, start: '23:00', end: '07:00' },
        ...settings,
      },
      cameraWorks: true,
      epoch: 7,
      stays: false,
      console: { at: noon, timeZone: 'Europe/Amsterdam' },
      onBattery: false,
      now: noon,
      ...o,
    }) as CameraWantInput;

  it('wants it for the clock by day on mains while the console asks, and for the lock with When you leave', () => {
    expect(cameraWant(input())).toEqual({ lock: null, clock: true });
    expect(cameraWant(input({}, { presence: true }))).toEqual({ lock: 7, clock: true });
    expect(cameraWant(input({}, { presence: true, cameraWake: false }))).toEqual({ lock: 7, clock: false });
    expect(cameraWant(input({}, { cameraWake: false }))).toEqual({ lock: null, clock: false });
  });

  it('not for the clock in quiet hours, on battery, or once the console hasn’t asked for 10 s', () => {
    // 00:30 in Amsterdam.
    const night = Date.parse('2026-10-20T22:30:00.000Z');
    expect(
      cameraWant(input({ now: night, console: { at: night, timeZone: 'Europe/Amsterdam' } })).clock,
    ).toBe(false);
    expect(
      cameraWant(
        input(
          { now: night, console: { at: night, timeZone: 'Europe/Amsterdam' } },
          { quietHours: { enabled: false, start: '23:00', end: '07:00' } },
        ),
      ).clock,
    ).toBe(true);
    expect(cameraWant(input({ onBattery: true })).clock).toBe(false);
    expect(cameraWant(input({ now: noon + CONSOLE_ASKED_MS })).clock).toBe(true);
    expect(cameraWant(input({ now: noon + CONSOLE_ASKED_MS + 1 })).clock).toBe(false);
    expect(cameraWant(input({ console: null })).clock).toBe(false);
  });

  it('not for the lock when the unlock stays or When you press Lock wins over an older app’s switch (DK-76)', () => {
    expect(cameraWant(input({}, { presence: true, stayUnlocked: true })).lock).toBeNull();
    expect(cameraWant(input({ stays: true }, { presence: true })).lock).toBeNull();
  });

  it('never unpaired or where the camera doesn’t work', () => {
    expect(cameraWant(input({ settings: null }))).toEqual({ lock: null, clock: false });
    expect(cameraWant(input({ cameraWorks: false }, { presence: true }))).toEqual({
      lock: null,
      clock: false,
    });
  });
});

describe('what counts as a face (DK-S35)', () => {
  const at = (ms: number) => ms;

  it('counts faces only from frames after the unlock, and a watching picture only on a fresh frame', () => {
    const lock = new DeskLock();
    lock.unlock(at(10_000));
    expect(lock.watchFrom(lock.epoch, at(10_000))).toBe(true);
    // The camera was still on from before: a face seen before this unlock doesn't count.
    lock.seen(
      lock.epoch,
      { state: 'watching', face: false, seenAt: at(9_000), frameAt: at(11_000) },
      at(11_000),
    );
    expect(lock.untilAt()).toBe(at(10_000) + UNLOCK_IDLE_MS);
    // A face whose latest frame is old: the camera stopped sending pictures, DK-04's rule.
    lock.seen(
      lock.epoch,
      { state: 'watching', face: true, seenAt: at(12_000), frameAt: at(12_000) },
      at(20_000),
    );
    expect(lock.untilAt()).toBe(at(12_000) + UNLOCK_IDLE_MS);
    expect(lock.view(at(20_000), null).present).toBeUndefined();
    // A time ahead of the runtime's clock counts as now.
    lock.seen(
      lock.epoch,
      { state: 'watching', face: true, seenAt: at(99_000), frameAt: at(22_000) },
      at(22_000),
    );
    expect(lock.untilAt()).toBe(at(22_000) + PRESENCE_GONE_MS);
  });

  it('drops what was seen for an earlier unlock, and never undoes a lock', () => {
    const lock = new DeskLock();
    lock.unlock(0);
    const first = lock.epoch;
    lock.watchFrom(first, 0);
    lock.unlock(1_000);
    expect(lock.seen(first, { state: 'watching', face: true, seenAt: 1_500, frameAt: 1_500 }, 1_500)).toBe(
      false,
    );
    lock.watchFrom(lock.epoch, 1_000);
    lock.seen(lock.epoch, { state: 'watching', face: true, seenAt: 2_000, frameAt: 2_000 }, 2_000);
    const gone = 2_000 + PRESENCE_GONE_MS;
    expect(lock.unanswered(lock.epoch, gone)).toBe(false);
    lock.unwatched(lock.epoch, gone);
    expect(lock.unlocked(gone)).toBe(false);
    expect(lock.touch(gone)).toBeNull();
  });
});

describe('the presence service’s client', () => {
  let server: FakePresenceServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('asks its health, watches and stops over the socket', async () => {
    let now = Date.parse('2026-10-20T12:00:00.000Z');
    server = await startFakePresence({ presence: new FakePresence(() => now) });
    const client = new PresenceSocketClient(server.socketPath);
    expect(await client.health()).toEqual({ camera: true, detector: true });
    expect(await client.watch()).toEqual({ state: 'starting', face: false, seenAt: null, frameAt: null });
    now += 500;
    expect(await client.watch()).toEqual({ state: 'watching', face: true, seenAt: now, frameAt: now });
    expect(server.presence.cameraOn()).toBe(true);
    await client.stop();
    expect(server.presence.cameraOn()).toBe(false);
    expect(server.presence.calls).toEqual(['watch', 'watch', 'stop']);
  });

  it('turns the service’s refusals into codes', async () => {
    server = await startFakePresence();
    const client = new PresenceSocketClient(server.socketPath);
    const codeOf = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (err: unknown) => (err instanceof PresenceCallError ? err.code : 'other'),
      );
    server.presence.failNext = new PresenceCallError('unavailable', 'the camera is busy');
    expect(await codeOf(client.watch())).toBe('unavailable');
    await server.close();
    server = null;
    expect(await codeOf(client.health())).toBe('unavailable');
  });
});

describe('which presence service and its health', () => {
  const config = (c: Partial<Config>) => ({ config: c as Config });

  it('is the fake, the socket’s client or none, as the config says', () => {
    expect(presenceFor(config({ WHOMBAT_PRESENCE: 'fake' }))).toBeInstanceOf(FakePresence);
    expect(
      presenceFor(config({ WHOMBAT_PRESENCE_SOCKET: '/run/whombat-presence/presence.sock' })),
    ).toBeInstanceOf(PresenceSocketClient);
    expect(
      presenceFor(
        config({ WHOMBAT_PRESENCE: 'off', WHOMBAT_PRESENCE_SOCKET: '/run/whombat-presence/presence.sock' }),
      ),
    ).toBeNull();
    expect(presenceFor(config({}))).toBeNull();
  });

  it('asks once a minute, and says there is no camera when the service doesn’t answer', async () => {
    let asked = 0;
    const fake = new FakePresence();
    fake.ability = { camera: true, detector: false };
    const port: PresencePort = {
      health: async () => {
        asked++;
        return fake.health();
      },
      watch: () => fake.watch(),
      stop: () => fake.stop(),
    };
    const services = config({});
    setPresenceFor(services, port);
    expect(await presenceHealth(services)).toEqual({ camera: true, detector: false });
    expect(await presenceHealth(services)).toEqual({ camera: true, detector: false });
    expect(asked).toBe(1);
    setPresenceFor(services, { ...port, health: async () => Promise.reject(new Error('gone')) });
    expect(await presenceHealth(services)).toEqual(NO_PRESENCE);
    setPresenceFor(services, null);
    expect(await presenceHealth(services)).toEqual(NO_PRESENCE);
  });
});
