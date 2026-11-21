/**
 * The box's Bluetooth for the person (bluetooth-server.md BT-S02…BT-S05): reads that degrade to `unavailable` (logged once a
 * minute), the service's refusals mapped to the session's codes, the person's devices only, and the audit rule — one record per
 * pairing that ends `done` however many reads see it, one per removal, none for a failure, and never an address.
 */
import { BLUETOOTH_RESULT_KEEP_S, type BluetoothState } from '@whombat/protocol/session';
import { describe, expect, it, vi } from 'vitest';
import { type CommandScope, currentCommandScope, runInCommandScope } from '../commit/scope';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { BluetoothCallError, type BluetoothPort } from './bluetooth-client';
import { FakeBluetooth } from './fake-bluetooth';
import {
  type BluetoothRecord,
  bluetoothFor,
  HostBluetoothError,
  HostBluetoothService,
  hostBluetoothConfirmOp,
  hostBluetoothForgetOp,
  hostBluetoothOp,
  hostBluetoothPairOp,
  hostBluetoothScanOp,
} from './host-bluetooth';
import { SessionOpError } from './session-error';
import type { SessionPrincipal } from './trust';

const STEP = 100;
const MOUSE = 'D4:3A:2C:91:7E:0B';
const MAGIC = '7C:C1:80:5D:44:E2';
const OLD = '00:1A:7D:DA:71:13';
const SONY = '88:C9:E8:3B:20:5F';
const ADDRESSES = [MOUSE, MAGIC, OLD, SONY];

function setup(port?: (now: () => number) => BluetoothPort) {
  let now = Date.parse('2026-10-20T12:00:00.000Z');
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const services = { clock: () => new Date(now), log } as unknown as Services;
  const fake = new FakeBluetooth(() => now, { stepMs: STEP });
  const records: BluetoothRecord[] = [];
  let failRecord = false;
  // The watcher's timers, run by hand.
  const timers: { at: number; fn: () => void }[] = [];
  const bluetooth = new HostBluetoothService(services, port ? port(() => now) : fake, {
    record: async (r) => {
      if (failRecord) throw new Error('database gone');
      records.push(r);
    },
    after: (ms, fn) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
  });
  return {
    services,
    log,
    fake,
    bluetooth,
    records,
    timers,
    failRecords: () => {
      failRecord = true;
    },
    later: (ms: number) => {
      now += ms;
    },
    /** Steps the clock to the watcher's next check and runs it. */
    tick: async () => {
      const timer = timers.shift();
      if (!timer) throw new Error('nothing scheduled');
      now = Math.max(now, timer.at);
      timer.fn();
      await vi.waitFor(() => expect(timers.length > 0 || !bluetooth.following).toBe(true));
    },
    logged: () => JSON.stringify([log.warn.mock.calls, log.info.mock.calls, log.error.mock.calls]),
  };
}

const owner = {
  peerId: '12D3KooWowner',
  publicKey: 'aa',
  endpoint: { id: 'ep_owner' },
  account: { id: 'acc_owner' },
  authzGeneration: 1,
} as unknown as SessionPrincipal;
/** A device that isn't let in (one-person.md OP-S06: every enrolled device is the person's). */
const stranger = { ...owner, endpoint: null, account: null } as SessionPrincipal;
const app = { via: 'app', accountId: 'acc_owner', endpointId: 'ep_owner' } as const;

async function refused(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('not refused');
}

describe('reading the box’s Bluetooth (BT-S02)', () => {
  it('answers the state, and unavailable when the service doesn’t answer, warning once a minute', async () => {
    const t = setup();
    expect((await t.bluetooth.read()).bluetooth?.devices).toHaveLength(2);
    t.fake.down = true;
    expect(await t.bluetooth.read()).toEqual({ bluetooth: null, reason: 'unavailable' });
    await t.bluetooth.read();
    expect(t.log.warn).toHaveBeenCalledTimes(1);
    expect(t.log.warn.mock.calls[0]?.[0]).toMatchObject({ status: 503, code: 'unavailable' });
    t.later(60_000);
    await t.bluetooth.read();
    expect(t.log.warn).toHaveBeenCalledTimes(2);
  });

  it('says no_bluetooth for a scan without an adapter that is on, without a warning', async () => {
    const t = setup();
    t.fake.missing = 'disabled';
    expect(await t.bluetooth.scan()).toEqual({ scan: null, reason: 'no_bluetooth' });
    t.fake.missing = null;
    t.fake.down = true;
    expect(await t.bluetooth.scan()).toEqual({ scan: null, reason: 'unavailable' });
    expect(t.log.warn).toHaveBeenCalledTimes(1);
  });

  it('picks the fake, the socket, or none from the configuration', () => {
    const fake = { config: { WHOMBAT_BLUETOOTH: 'fake' as const } };
    expect(bluetoothFor(fake)).toBeInstanceOf(FakeBluetooth);
    expect(bluetoothFor(fake)).toBe(bluetoothFor(fake));
    expect(
      bluetoothFor({ config: { WHOMBAT_BLUETOOTH_SOCKET: '/run/whombat-bluetooth/bluetooth.sock' } }),
    ).not.toBe(null);
    expect(
      bluetoothFor({
        config: {
          WHOMBAT_BLUETOOTH: 'off' as const,
          WHOMBAT_BLUETOOTH_SOCKET: '/run/whombat-bluetooth/b.sock',
        },
      }),
    ).toBeNull();
    expect(bluetoothFor({ config: {} })).toBeNull();
  });
});

describe('a pairing in the audit chain (BT-S04)', () => {
  it('records a pairing once when it is done, however many reads see it', async () => {
    const t = setup();
    await t.bluetooth.scan();
    t.later(5_000);
    const pairing = await t.bluetooth.pair(MOUSE, app);
    expect(pairing.phase).toBe('pairing');
    t.later(2 * STEP);
    const reads = await Promise.all([t.bluetooth.state(), t.bluetooth.state(), t.bluetooth.read()]);
    expect(reads.every((r) => r !== null)).toBe(true);
    await t.bluetooth.state();
    await vi.waitFor(() => expect(t.records).toHaveLength(1));
    expect(t.records[0]).toMatchObject({
      kind: 'paired',
      actorAccountId: 'acc_owner',
      endpointId: 'ep_owner',
      payload: { name: 'MX Master 3S', kind: 'mouse', via: 'app' },
    });
    expect(t.bluetooth.following).toBe(false);
    expect(t.timers).toHaveLength(1);
    await t.tick();
    expect(t.records).toHaveLength(1);
  });

  it('follows a pairing nobody reads, and records it as the screen’s', async () => {
    const t = setup();
    await t.bluetooth.scan();
    t.later(5_000);
    await t.bluetooth.pair(MAGIC, { via: 'screen' });
    while (t.bluetooth.following) await t.tick();
    await vi.waitFor(() => expect(t.records).toHaveLength(1));
    expect(t.records[0]).toMatchObject({
      kind: 'paired',
      actorAccountId: null,
      endpointId: null,
      payload: { name: 'Magic Keyboard', kind: 'keyboard', via: 'screen' },
    });
    expect(t.timers).toHaveLength(0);
    // Only the watcher read the state.
    expect(t.fake.calls).toEqual(['scan', `pair ${MAGIC}`, 'state']);
  });

  it('records nothing for a pairing that failed or was canceled', async () => {
    const t = setup();
    await t.bluetooth.scan();
    t.later(5_000);
    await t.bluetooth.pair(OLD, app);
    while (t.bluetooth.following) await t.tick();
    await t.bluetooth.scan();
    t.later(5_000);
    const p = await t.bluetooth.pair(MOUSE, app);
    expect((await t.bluetooth.cancel(p.id)).failure).toBe('canceled');
    expect(t.bluetooth.following).toBe(false);
    expect(t.records).toEqual([]);
  });

  it('isn’t told by a read sent before the pairing started that it is gone', async () => {
    let hold: (() => void) | null = null;
    const t = setup();
    const fake = t.fake;
    // The first read after `slow` waits until the pair has been answered.
    let slow = false;
    const port: BluetoothPort = {
      scan: () => fake.scan(),
      pair: (a) => fake.pair(a),
      confirm: (id, accept) => fake.confirm(id, accept),
      cancel: (id) => fake.cancel(id),
      connect: (a) => fake.connect(a),
      disconnect: (a) => fake.disconnect(a),
      forget: (a) => fake.forget(a),
      state: async () => {
        const answer = await fake.state();
        if (slow) {
          slow = false;
          await new Promise<void>((resolve) => {
            hold = resolve;
          });
        }
        return answer;
      },
    };
    const bluetooth = new HostBluetoothService(t.services, port, {
      record: async (r) => {
        t.records.push(r);
      },
      after: () => () => {},
    });
    await fake.scan();
    t.later(5_000);
    slow = true;
    const stale = bluetooth.state();
    await vi.waitFor(() => expect(hold).not.toBeNull());
    await bluetooth.pair(MOUSE, app);
    (hold as unknown as () => void)();
    expect((await stale)?.pairing).toBeNull();
    expect(bluetooth.following).toBe(true);
    t.later(2 * STEP);
    await bluetooth.state();
    await vi.waitFor(() => expect(t.records).toHaveLength(1));
  });

  it('lets a pairing go unrecorded once the service no longer shows it', async () => {
    const t = setup();
    await t.bluetooth.scan();
    t.later(5_000);
    await t.bluetooth.pair(MAGIC, app);
    t.fake.missing = 'no_adapter';
    await t.bluetooth.state();
    expect(t.bluetooth.following).toBe(false);
    expect(t.records).toEqual([]);
  });

  it('stops following a service that stopped answering once its result would be gone', async () => {
    const t = setup();
    await t.bluetooth.scan();
    t.later(5_000);
    const p = await t.bluetooth.pair(MAGIC, app);
    t.fake.down = true;
    t.later(Date.parse(p.deadline) - t.services.clock().getTime() + BLUETOOTH_RESULT_KEEP_S * 1000 - 1);
    await t.tick();
    expect(t.bluetooth.following).toBe(true);
    await t.tick();
    expect(t.bluetooth.following).toBe(false);
    expect(t.timers).toHaveLength(0);
  });

  it('settles a pairing of ours before starting the next one', async () => {
    const t = setup();
    await t.bluetooth.scan();
    t.later(5_000);
    await t.bluetooth.pair(MOUSE, app);
    t.later(2 * STEP);
    await t.bluetooth.scan();
    t.later(5_000);
    await t.bluetooth.pair(MAGIC, app);
    await vi.waitFor(() => expect(t.records.map((r) => r.payload.name)).toEqual(['MX Master 3S']));
  });

  it('writes a pairing a request merely saw outside that request’s command, a removal inside its own', async () => {
    const scoped: [string, boolean][] = [];
    const t = setup();
    const bluetooth = new HostBluetoothService(t.services, t.fake, {
      record: async (r) => {
        scoped.push([r.kind, currentCommandScope() !== null]);
      },
      after: () => () => {},
    });
    const scope = { active: true, accepted: false, beforeCommit: async () => {}, afterCommit: () => {} };
    const inCommand = <T>(fn: () => Promise<T>) => runInCommandScope(scope as CommandScope, fn);
    await bluetooth.scan();
    t.later(5_000);
    await inCommand(() => bluetooth.pair(MOUSE, app));
    t.later(2 * STEP);
    await inCommand(() => bluetooth.state());
    await inCommand(() => bluetooth.forget(SONY, app));
    await vi.waitFor(() => expect(scoped).toHaveLength(2));
    expect(scoped).toEqual([
      ['paired', false],
      ['removed', true],
    ]);
  });

  it('answers the pairing when its record can’t be written, and logs that', async () => {
    const t = setup();
    t.failRecords();
    await t.bluetooth.scan();
    t.later(5_000);
    await t.bluetooth.pair(MOUSE, app);
    t.later(2 * STEP);
    expect((await t.bluetooth.state())?.pairing?.phase).toBe('done');
    await vi.waitFor(() => expect(t.log.error).toHaveBeenCalledTimes(1));
  });
});

describe('removing a device (BT-S05)', () => {
  it('records its name and kind as the paired list had them', async () => {
    const t = setup();
    await t.bluetooth.forget(SONY, app);
    expect(t.records).toEqual([
      expect.objectContaining({
        kind: 'removed',
        actorAccountId: 'acc_owner',
        payload: { name: 'WH-1000XM5', kind: 'headphones', via: 'app' },
      }),
    ]);
  });

  it('records nothing when the service refused', async () => {
    const t = setup();
    expect(await refused(t.bluetooth.forget('11:22:33:44:55:66', app))).toMatchObject({ code: 'not_found' });
    expect(t.records).toEqual([]);
  });
});

describe('the session ops (BT-S03)', () => {
  it('are the person’s devices’ only', async () => {
    const t = setup();
    for (const op of [
      hostBluetoothOp({ principal: stranger, bluetooth: t.bluetooth }),
      hostBluetoothScanOp({ principal: stranger, bluetooth: t.bluetooth }),
      hostBluetoothPairOp({ principal: stranger, bluetooth: t.bluetooth }, { address: MOUSE }),
    ]) {
      const err = await refused(op);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('unauthorized');
    }
  });

  it('say not_managed without a Bluetooth service, and refuse its changes no_bluetooth', async () => {
    expect(await hostBluetoothOp({ principal: owner, bluetooth: undefined })).toEqual({
      bluetooth: null,
      reason: 'not_managed',
    });
    expect(await hostBluetoothScanOp({ principal: owner, bluetooth: undefined })).toEqual({
      scan: null,
      reason: 'not_managed',
    });
    const err = await refused(
      hostBluetoothForgetOp({ principal: owner, bluetooth: undefined }, { address: SONY }),
    );
    expect(err).toBeInstanceOf(SessionOpError);
    expect(err).toMatchObject({ code: 'not_allowed', details: { code: 'no_bluetooth' } });
  });

  it('map the service’s refusals to session codes with Bluetooth’s own in details', async () => {
    const t = setup();
    const c = { principal: owner, bluetooth: t.bluetooth };
    expect(await refused(hostBluetoothPairOp(c, { address: MOUSE }))).toMatchObject({
      code: 'not_found',
      details: { code: 'not_found' },
    });
    await t.bluetooth.scan();
    t.later(5_000);
    const { pairing } = await hostBluetoothPairOp(c, { address: MAGIC });
    expect(await refused(hostBluetoothPairOp(c, { address: MOUSE }))).toMatchObject({
      code: 'conflict',
      details: { code: 'busy' },
    });
    // Looking again while a pairing runs is refused too, not a reason (BT-S03).
    expect(await refused(hostBluetoothScanOp(c))).toMatchObject({
      code: 'conflict',
      details: { code: 'busy' },
    });
    expect(
      await refused(hostBluetoothConfirmOp(c, { pairingId: 'p-nottheone1', accept: true })),
    ).toMatchObject({
      code: 'not_found',
    });
    expect((await hostBluetoothConfirmOp(c, { pairingId: pairing.id, accept: true })).pairing.id).toBe(
      pairing.id,
    );
    t.fake.down = true;
    const down = await refused(hostBluetoothForgetOp(c, { address: SONY }));
    expect(down).toMatchObject({ code: 'unavailable' });
    expect((down as SessionOpError).details).toBeUndefined();
  });

  it('treat an answer outside the contract or a dead socket as unavailable', async () => {
    const failing = (code: string, status: number): BluetoothPort =>
      ({
        pair: async () => {
          throw new BluetoothCallError('/v1/bluetooth/pair', status, code, `bluetooth: ${status} ${code}`);
        },
      }) as unknown as BluetoothPort;
    for (const [code, status] of [
      ['invalid_answer', 200],
      ['unreachable', 0],
      ['bad_request', 400],
    ] as const) {
      const t = setup(() => failing(code, status));
      const err = await refused(t.bluetooth.pair(MOUSE, app));
      expect(err).toBeInstanceOf(HostBluetoothError);
      expect((err as HostBluetoothError).code).toBe('unavailable');
    }
  });
});

describe('addresses stay out of logs and records (BT-10)', () => {
  it('logs and records names and kinds only', async () => {
    const t = setup();
    await t.bluetooth.scan();
    t.later(5_000);
    await t.bluetooth.pair(MOUSE, app);
    while (t.bluetooth.following) await t.tick();
    await t.bluetooth.connect(SONY, app);
    await t.bluetooth.disconnect(SONY, app);
    await t.bluetooth.forget(SONY, app);
    t.fake.down = true;
    await t.bluetooth.state();
    await refused(t.bluetooth.connect(SONY, app));
    await vi.waitFor(() => expect(t.records).toHaveLength(2));
    const text = t.logged() + JSON.stringify(t.records);
    for (const address of ADDRESSES) expect(text).not.toContain(address);
    expect(text).toContain('MX Master 3S');
  });

  it('keeps a state the contract allows', async () => {
    const t = setup();
    const state = (await t.bluetooth.state()) as BluetoothState;
    expect(state.devices[0]?.connected).toBe(true);
  });
});
