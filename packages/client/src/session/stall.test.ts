import { api } from '@whombat/core/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAppliance, type FakeApplianceOptions } from './fake';
import { createSecureSession, type SecureSessionOptions } from './secure';
import type { ApplianceSession } from './types';
import type { SessionConnector } from './wire';

/** Stuck connections and stuck dials (open-speed.md AP-4400…AP-4403). */

const EMPTY = { params: {}, query: {}, body: undefined };

let live: ApplianceSession[] = [];
afterEach(() => {
  for (const s of live) s.close();
  live = [];
});

function setup(fake: Partial<FakeApplianceOptions> = {}, session: Partial<SecureSessionOptions> = {}) {
  const appliance = createFakeAppliance({
    handle: async (op) => ({ status: 200, body: { op } }),
    ...fake,
  });
  const s = createSecureSession({
    connector: appliance.connector,
    backoff: { initialMs: 2, maxMs: 10 },
    statusPollMs: 5,
    raceAfterMs: 0,
    stallMs: 0,
    ...session,
  });
  live.push(s);
  return { appliance, session: s };
}

function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() > end) return reject(new Error('timed out waiting'));
      setTimeout(tick, 2);
    };
    tick();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const opened = (s: ApplianceSession) => until(() => s.state().status === 'open');

describe('a connection that goes quiet with work outstanding (AP-4401)', () => {
  it('is replaced, and a read waiting on it is asked again on the new connection', async () => {
    const { appliance, session } = setup({}, { stallMs: 20 });
    session.connect();
    await opened(session);
    appliance.faults.stall();
    const answer = await session.call(api.health.get, EMPTY);
    expect(answer.status).toBe(200);
    expect(appliance.stats().connects).toBe(2);
  });

  it('is not replaced while a slow answer is on its way: the ping comes back', async () => {
    const { appliance, session } = setup(
      {
        handle: async (op) => {
          await sleep(150);
          return { status: 200, body: { op } };
        },
      },
      { stallMs: 20 },
    );
    session.connect();
    await opened(session);
    const answer = await session.call(api.health.get, EMPTY);
    expect(answer.status).toBe(200);
    expect(appliance.stats().connects).toBe(1);
  });

  it('leaves an idle connection to the heartbeat', async () => {
    const { appliance, session } = setup({}, { stallMs: 10 });
    session.connect();
    await opened(session);
    appliance.faults.stall();
    await sleep(120);
    expect(appliance.stats().connects).toBe(1);
    expect(session.state().status).toBe('open');
  });

  it('waits longer after a stuck connection, so a slow network is not dropped over and over', async () => {
    const { appliance, session } = setup({}, { stallMs: 25 });
    session.connect();
    await opened(session);
    appliance.faults.stall();
    let started = Date.now();
    await session.call(api.health.get, EMPTY);
    const first = Date.now() - started;
    appliance.faults.stall();
    started = Date.now();
    await session.call(api.health.get, EMPTY);
    const second = Date.now() - started;
    expect(appliance.stats().connects).toBe(3);
    // The first is found after about 2 × 25 ms, the next after about 2 × 50 ms.
    expect(second).toBeGreaterThan(first + 20);
  });
});

describe('the heartbeat of an idle connection', () => {
  it('keeps a connection whose timer runs late, as in a hidden browser tab', async () => {
    // Time runs five times faster than the timers: every heartbeat comes five intervals late, the last answer always
    // older than the old limit, while each ping is still answered.
    const start = Date.now();
    const { appliance, session } = setup(
      {},
      { heartbeatMs: 10, now: () => start + (Date.now() - start) * 5 },
    );
    session.connect();
    await opened(session);
    await sleep(150);
    expect(appliance.stats().connects).toBe(1);
    expect(session.state().status).toBe('open');
  });

  it('replaces a connection whose pings go unanswered', async () => {
    const { appliance, session } = setup({}, { heartbeatMs: 10 });
    session.connect();
    await opened(session);
    appliance.faults.stall();
    await until(() => appliance.stats().connects === 2, 1000);
    await opened(session);
  });
});

describe('a connection that goes quiet while the agent thinks', () => {
  const thinking = (active: boolean) => ({
    type: 'typing',
    conversationId: 'cnv_chat',
    threadRootId: null,
    principalId: 'prn_dusty',
    active,
    expiresAt: new Date(Date.now() + 6000).toISOString(),
  });

  it('is replaced within seconds instead of waiting for the heartbeat', async () => {
    const { appliance, session } = setup({}, { stallMs: 20 });
    const seen: string[] = [];
    session.connect();
    await opened(session);
    session.subscribe(['conv:cnv_chat'], {
      onEvent: (e) => seen.push(e.topic),
      onSnapshotRequired: () => undefined,
    });
    await sleep(20);
    appliance.publishLive('conv:cnv_chat', thinking(true));
    await until(() => seen.length === 1);
    appliance.faults.stall();
    await until(() => appliance.stats().connects === 2, 1000);
  });

  it('is left alone once the thinking line has ended', async () => {
    const { appliance, session } = setup({}, { stallMs: 10 });
    const seen: string[] = [];
    session.connect();
    await opened(session);
    session.subscribe(['conv:cnv_chat'], {
      onEvent: (e) => seen.push(e.topic),
      onSnapshotRequired: () => undefined,
    });
    await sleep(20);
    appliance.publishLive('conv:cnv_chat', thinking(false));
    await until(() => seen.length === 1);
    appliance.faults.stall();
    await sleep(120);
    expect(appliance.stats().connects).toBe(1);
  });
});

describe('a connection whose newest bytes are stuck while older answers trickle in (AP-4409)', () => {
  it('is replaced when its ping gets no pong, though answers sent before it still arrive', async () => {
    let asked = 0;
    const { appliance, session } = setup(
      {
        handle: async (op) => {
          asked += 1;
          // On the first connection: five answers 30 ms apart, the sixth stuck; on the next one, at once.
          if (appliance.stats().connects === 1) {
            if (asked > 5) await new Promise(() => undefined);
            await sleep(30 + 30 * asked);
          }
          return { status: 200, body: { op } };
        },
      },
      { stallMs: 50 },
    );
    session.connect();
    await opened(session);
    appliance.faults.mutePongs();
    const answers = await Promise.all(Array.from({ length: 6 }, () => session.call(api.health.get, EMPTY)));
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(appliance.stats().connects).toBe(2);
    // Replaced while the first ones still trickled in: the later ones were asked again on the new connection. Waiting
    // for silence instead would have let all five arrive on the old one and asked only the sixth again (7).
    expect(asked).toBeGreaterThan(7);
  });
});

describe('a dial that hangs (AP-4400)', () => {
  it('gets a second attempt beside it, and the session opens on that one', async () => {
    const { appliance, session } = setup({}, { raceAfterMs: 20 });
    appliance.faults.hangConnects(1);
    session.connect();
    await opened(session);
    expect(appliance.stats().connects).toBe(2);
    // The hung attempt is given up once the other one opened.
    await until(() => appliance.stats().abandoned === 1);
    expect(appliance.stats().open).toBe(1);
  });

  it('does the same for the bulk connection a download needs', async () => {
    const bytes = new TextEncoder().encode('a photo');
    const { appliance, session } = setup(
      {
        resources: async () => ({
          meta: { contentType: 'image/png', size: bytes.byteLength, name: 'a.png', sha256: null },
          bytes,
        }),
      },
      { raceAfterMs: 20 },
    );
    session.connect();
    await opened(session);
    appliance.faults.hangConnects(1);
    const stream = await session.openResource({ kind: 'attachment', burrow: 'b', attachmentId: 'att_1' });
    const chunks: Uint8Array[] = [];
    for await (const c of stream.chunks) chunks.push(c);
    expect(new TextDecoder().decode(chunks[0])).toBe('a photo');
    await until(() => appliance.stats().abandoned === 1);
  });

  it('is not raced when it fails at once: the refusal goes through the usual backoff', async () => {
    const { appliance, session } = setup({}, { raceAfterMs: 1000 });
    appliance.faults.failConnects('appliance_offline', 1);
    session.connect();
    await opened(session);
    // One refused attempt, then one after the backoff: no attempt was started beside the refused one.
    expect(appliance.stats().connects).toBe(2);
  });
});

describe('the bulk connection, warmed beside the interactive one (AP-4406)', () => {
  const bytes = new TextEncoder().encode('a photo');
  const resources = async () => ({
    meta: { contentType: 'image/png', size: bytes.byteLength, name: 'a.png', sha256: null },
    bytes,
  });
  const photo = { kind: 'attachment', burrow: 'b', attachmentId: 'att_1' } as const;
  const read = async (s: ApplianceSession) => {
    const stream = await s.openResource(photo);
    const chunks: Uint8Array[] = [];
    for await (const c of stream.chunks) chunks.push(c);
    return new TextDecoder().decode(chunks[0]);
  };

  it('is dialed at once, and the first download uses it', async () => {
    const { appliance, session } = setup({ resources });
    session.connect();
    session.warmBulk?.();
    await until(() => appliance.stats().open === 2);
    expect(await read(session)).toBe('a photo');
    expect(appliance.stats().connects).toBe(2);
  });

  it('that fails doesn’t fail a download waiting on it: that one dials again once the session is open', async () => {
    const { appliance, session } = setup({ resources });
    appliance.faults.offline(true);
    session.connect();
    session.warmBulk?.();
    const photoRead = read(session);
    await until(() => appliance.stats().connects >= 2);
    appliance.faults.offline(false);
    expect(await photoRead).toBe('a photo');
  });

  it('is given up when the session closes while it dials', async () => {
    const { appliance, session } = setup();
    appliance.faults.hangConnects(2);
    session.connect();
    session.warmBulk?.();
    await until(() => appliance.stats().connects === 2);
    session.close();
    await until(() => appliance.stats().abandoned === 2);
    expect(appliance.stats().open).toBe(0);
  });
});

describe('checking an open connection when the phone comes back (probe)', () => {
  // Fake timers and a fake clock: the waits below are the session's own, not time passing on this machine.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // A long backoff and heartbeat: a reconnect that waited the backoff out, or a heartbeat, would come far later.
  const quiet = { backoff: { initialMs: 60_000, maxMs: 60_000 }, heartbeatMs: 600_000 };

  /** The fake appliance behind a wire whose sends can be made to fail while it stays open. */
  function probed(session: Partial<SecureSessionOptions> = {}) {
    const appliance = createFakeAppliance({ handle: async (op) => ({ status: 200, body: { op } }) });
    let failSends = false;
    const connector: SessionConnector = {
      async connect(request) {
        const w = await appliance.connector.connect(request);
        return {
          send: (frame) => {
            if (failSends) throw new Error('socket gone');
            w.send(frame);
          },
          onFrame: (l) => w.onFrame(l),
          onClose: (l) => w.onClose(l),
          close: (r) => w.close(r),
          bytesSent: () => w.bytesSent(),
          congested: () => w.congested(),
          drained: () => w.drained(),
        };
      },
    };
    const s = createSecureSession({ connector, raceAfterMs: 0, stallMs: 100, ...quiet, ...session });
    live.push(s);
    return { appliance, session: s, failSends: (on: boolean) => (failSends = on) };
  }

  /** Lets the fake answer (its frames go through microtasks) and `ms` of the session's time pass. */
  const pass = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
  async function open(s: ApplianceSession) {
    s.connect();
    for (let i = 0; i < 500 && s.state().status !== 'open'; i++) await pass(1);
    expect(s.state().status).toBe('open');
  }

  it('replaces a connection that died silently, at once and without the backoff', async () => {
    const { appliance, session } = probed();
    await open(session);
    appliance.faults.stall();
    session.probe?.();
    await pass(99);
    expect(appliance.stats().connects).toBe(1);
    await pass(1);
    await open(session);
    expect(appliance.stats().connects).toBe(2);
  });

  it('replaces one whose pings go unanswered while older answers still come', async () => {
    const { appliance, session } = probed();
    await open(session);
    appliance.faults.mutePongs();
    session.probe?.();
    await pass(100);
    appliance.faults.mutePongs(false);
    await open(session);
    expect(appliance.stats().connects).toBe(2);
  });

  it('keeps a connection that answers, and its answer ends the check', async () => {
    const { appliance, session } = probed();
    await open(session);
    session.probe?.();
    await pass(10);
    const pings = appliance.stats().pings;
    // Answered: no check is out, so coming back to the foreground has nothing to ask again.
    session.probe?.({ onlyIfChecking: true });
    await pass(1);
    expect(appliance.stats().pings).toBe(pings);
    await pass(500);
    expect(appliance.stats().connects).toBe(1);
    expect(session.state().status).toBe('open');
  });

  it('a second change while a check is out pings again and waits its own time', async () => {
    const { appliance, session } = probed();
    await open(session);
    appliance.faults.mutePongs();
    session.probe?.();
    await pass(80);
    const pings = appliance.stats().pings;
    session.probe?.();
    await pass(1);
    expect(appliance.stats().pings).toBe(pings + 1);
    // The first check's time is over; the second's isn't.
    await pass(60);
    expect(appliance.stats().connects).toBe(1);
    await pass(40);
    appliance.faults.mutePongs(false);
    await open(session);
    expect(appliance.stats().connects).toBe(2);
  });

  it('back in the foreground, a check begun before pings again', async () => {
    const { appliance, session } = probed();
    await open(session);
    appliance.faults.mutePongs();
    session.probe?.();
    await pass(1);
    const pings = appliance.stats().pings;
    appliance.faults.mutePongs(false);
    session.probe?.({ onlyIfChecking: true });
    await pass(1);
    expect(appliance.stats().pings).toBe(pings + 1);
    await pass(500);
    expect(appliance.stats().connects).toBe(1);
  });

  it('a ping that cannot be sent is a lost connection, dialed again at once', async () => {
    const { appliance, session, failSends } = probed();
    await open(session);
    failSends(true);
    session.probe?.();
    failSends(false);
    await open(session);
    expect(appliance.stats().connects).toBe(2);
  });

  it('waits as long as the stall check does now, longer after a stuck connection', async () => {
    const { appliance, session } = probed({ backoff: { initialMs: 2, maxMs: 2 } });
    await open(session);
    // A stuck read: the stall check finds it and its wait doubles for the next two minutes.
    appliance.faults.stall();
    const read = session.call(api.health.get, EMPTY);
    await pass(200);
    await open(session);
    await read;
    expect(appliance.stats().connects).toBe(2);
    appliance.faults.mutePongs();
    session.probe?.();
    await pass(150);
    expect(appliance.stats().connects).toBe(2);
    await pass(50);
    appliance.faults.mutePongs(false);
    await open(session);
    expect(appliance.stats().connects).toBe(3);
  });

  it('a check whose time ends far later than set (the app was frozen) gets one more short wait', async () => {
    const { appliance, session } = probed();
    await open(session);
    appliance.faults.mutePongs();
    session.probe?.();
    // The clock jumps a minute while no timer runs, as when Android froze the app.
    vi.setSystemTime(Date.now() + 60_000);
    await pass(100);
    expect(appliance.stats().connects).toBe(1);
    // The fresh ping's answer comes: kept.
    appliance.faults.mutePongs(false);
    session.probe?.({ onlyIfChecking: true });
    await pass(150);
    expect(appliance.stats().connects).toBe(1);
    expect(session.state().status).toBe('open');
  });

  it('given its one more wait, an unanswered check ends the connection', async () => {
    const { appliance, session } = probed();
    await open(session);
    appliance.faults.mutePongs();
    session.probe?.();
    vi.setSystemTime(Date.now() + 60_000);
    await pass(100);
    expect(appliance.stats().connects).toBe(1);
    await pass(100);
    appliance.faults.mutePongs(false);
    await open(session);
    expect(appliance.stats().connects).toBe(2);
  });

  it('does nothing while the session is not open', async () => {
    const { appliance, session } = probed();
    session.probe?.();
    await pass(200);
    expect(appliance.stats().connects).toBe(0);
    expect(session.state().status).toBe('idle');
  });

  it('does not lengthen the stall check that follows', async () => {
    const { appliance, session } = probed({ backoff: { initialMs: 2, maxMs: 2 } });
    await open(session);
    appliance.faults.stall();
    session.probe?.();
    await pass(100);
    await open(session);
    // A read stuck on the new connection is found after 2 × 100 ms of the session's time, not twice that.
    appliance.faults.stall();
    const read = session.call(api.health.get, EMPTY);
    await pass(200);
    await open(session);
    await read;
    expect(appliance.stats().connects).toBe(3);
  });
});
