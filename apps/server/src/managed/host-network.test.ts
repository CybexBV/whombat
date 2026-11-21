/**
 * The box's hardware and network for the person (hardware-support-server.md HD-S02…HD-S06): reads that degrade to
 * `unavailable` (logged once a minute), changes with the manager's refusals mapped to the session's codes, one record in
 * the audit chain per change the manager took — and the passphrase in no log, record or request kept.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundWork } from '../lib/background';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { FakeHost } from './fake-host';
import { managerRefusedChange } from './host-calls';
import { HostHardwareService, hostHardwareOp } from './host-hardware';
import {
  HostNetworkError,
  HostNetworkService,
  type HostNetworkService as HostNetworkServiceType,
  hostCableSetOp,
  hostNetworkOp,
  hostWifiForgetOp,
  hostWifiJoinOp,
  hostWifiScanOp,
  type NetworkRecord,
  WIFI_CONFIRM_TIMEOUT_S,
} from './host-network';
import { HOST_HARDWARE_TIMEOUT_MS, HOST_WIFI_TIMEOUT_MS } from './manager-client';
import { ManagerCallError, type ManagerPort } from './ports';
import { SessionOpError } from './session-error';
import { FakeManager } from './testing';
import type { SessionPrincipal } from './trust';

const PASSPHRASE = 'correct-horse-42';

function setup() {
  let now = Date.parse('2026-10-20T12:00:00.000Z');
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const services = {
    clock: () => new Date(now),
    log,
    background: new BackgroundWork(() => log),
  } as unknown as Services;
  const manager = new FakeManager();
  manager.host = new FakeHost(() => now, { applyMs: 100, confirmMs: 200, keepMs: 1_000 });
  const records: NetworkRecord[] = [];
  let failRecord = false;
  const network = new HostNetworkService(services, manager, async (r) => {
    if (failRecord) throw new Error('database gone');
    records.push(r);
  });
  return {
    services,
    log,
    manager,
    network,
    records,
    failRecords: () => {
      failRecord = true;
    },
    later: (ms: number) => {
      now += ms;
    },
    /** Everything logged, as text. */
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
/** A device that hasn't enrolled: no account. */
const stranger = { ...owner, account: null } as unknown as SessionPrincipal;

async function refused(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('not refused');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('reading the network (HD-S04)', () => {
  it('passes the manager’s state and scan on', async () => {
    const s = setup();
    expect(await s.network.read()).toEqual({ network: expect.objectContaining({ online: true }) });
    const { scan } = await s.network.scan();
    expect(scan?.networks[0]).toMatchObject({ ssid: 'Home', signal: 4 });
  });

  it('is unavailable from an older manager, said once a minute, and `no_wifi` without a Wi-Fi card', async () => {
    const s = setup();
    s.manager.host.older = true;
    for (let i = 0; i < 5; i++) {
      expect(await s.network.read()).toEqual({ network: null, reason: 'unavailable' });
      s.later(2_000);
    }
    expect(s.log.warn).toHaveBeenCalledTimes(1);
    expect(s.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404 }),
      expect.stringContaining('yet'),
    );
    s.manager.host.older = false;
    s.manager.host.wifiMissing = 'no_adapter';
    expect(await s.network.scan()).toEqual({ scan: null, reason: 'no_wifi' });
    expect(s.log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('changing the Wi-Fi (HD-06, HD-S05, HD-S06)', () => {
  it('asks for the 2-minute guard and records the change as the person’s, without the passphrase', async () => {
    const s = setup();
    const change = await s.network.join(
      { ssid: 'Home', passphrase: PASSPHRASE },
      { via: 'app', accountId: 'acc_owner', endpointId: 'ep_owner' },
    );
    expect(change).toMatchObject({ kind: 'join', ssid: 'Home', phase: 'applying' });
    expect(s.manager.host.joins).toEqual([
      { ssid: 'Home', hidden: false, passphrase: true, confirmTimeoutSec: WIFI_CONFIRM_TIMEOUT_S },
    ]);
    expect(WIFI_CONFIRM_TIMEOUT_S).toBe(120);
    expect(s.records).toEqual([
      {
        kind: 'join',
        actorAccountId: 'acc_owner',
        endpointId: 'ep_owner',
        payload: { ssid: 'Home', via: 'app', changeId: change.id },
        at: expect.any(Date),
      },
    ]);
    s.later(300);
    await s.network.forget({ ssid: 'Home' }, { via: 'screen' });
    expect(s.records[1]).toMatchObject({
      kind: 'forget',
      actorAccountId: null,
      endpointId: null,
      payload: { ssid: 'Home', via: 'screen' },
    });
    expect(s.logged()).not.toContain(PASSPHRASE);
    expect(JSON.stringify(s.records)).not.toContain(PASSPHRASE);
  });

  it('says what the manager refused, and records nothing then', async () => {
    const s = setup();
    const by = { via: 'screen' } as const;
    await s.network.join({ ssid: 'Home', passphrase: PASSPHRASE }, by);
    expect(
      await refused(s.network.join({ ssid: 'Attic', passphrase: PASSPHRASE, hidden: true }, by)),
    ).toMatchObject({ code: 'busy' });
    s.later(300);
    expect(await refused(s.network.forget({ ssid: 'Nowhere' }, by))).toMatchObject({ code: 'not_saved' });
    s.manager.host.older = true;
    const older = await refused(s.network.forget({ ssid: 'Home' }, by));
    expect(older).toBeInstanceOf(HostNetworkError);
    expect(older).toMatchObject({ code: 'unavailable', message: expect.stringContaining('update') });
    expect(s.records).toHaveLength(1);
  });

  it('refuses a passphrase that can’t be one before asking the manager', async () => {
    const s = setup();
    expect(
      await refused(s.network.join({ ssid: 'Home', passphrase: 'short' }, { via: 'screen' })),
    ).toMatchObject({
      code: 'invalid_passphrase',
    });
    expect(s.manager.host.joins).toEqual([]);
    expect(s.logged()).not.toContain('short');
  });

  it('waits 15 seconds at most for the manager to take a change', async () => {
    vi.useFakeTimers();
    const s = setup();
    const stuck = { wifiJoin: () => new Promise(() => {}) } as unknown as ManagerPort;
    const network = new HostNetworkService(s.services, stuck, async () => {});
    const answer = refused(network.join({ ssid: 'Home', passphrase: PASSPHRASE }, { via: 'screen' }));
    await vi.advanceTimersByTimeAsync(HOST_WIFI_TIMEOUT_MS);
    expect(await answer).toMatchObject({ code: 'unavailable' });
    expect(s.log.warn).toHaveBeenCalledWith(expect.objectContaining({ status: 0 }), expect.any(String));
  });

  it('keeps a change the manager took when the audit log can’t be written', async () => {
    const s = setup();
    s.failRecords();
    const change = await s.network.join({ ssid: 'Home', passphrase: PASSPHRASE }, { via: 'screen' });
    expect(change.phase).toBe('applying');
    expect(s.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ changeId: change.id }),
      expect.any(String),
    );
  });

  it('knows which failures did nothing (a refusal, no manager listening) and which may have acted', () => {
    expect(managerRefusedChange(new ManagerCallError('/x', 409, 'busy', 'manager /x: 409'))).toBe(true);
    expect(managerRefusedChange(new ManagerCallError('/x', 0, 'unreachable', 'Error: connect ENOENT'))).toBe(
      true,
    );
    expect(managerRefusedChange(new ManagerCallError('/x', 0, 'unreachable', 'manager /x: timed out'))).toBe(
      false,
    );
    expect(managerRefusedChange(new ManagerCallError('/x', 502, 'unavailable', 'manager /x: 502'))).toBe(
      false,
    );
    expect(managerRefusedChange(new Error('socket hang up'))).toBe(false);
  });
});

describe('the session ops (§2.3)', () => {
  const ctx = (principal: SessionPrincipal, network?: HostNetworkServiceType) => ({ principal, network });

  it('are for the person’s enrolled devices only', async () => {
    const s = setup();
    for (const op of [
      hostNetworkOp(ctx(stranger, s.network)),
      hostWifiScanOp(ctx(stranger, s.network)),
      hostWifiJoinOp(ctx(stranger, s.network), { ssid: 'Home', passphrase: PASSPHRASE }),
      hostWifiForgetOp(ctx(stranger, s.network), { ssid: 'Office' }),
      hostHardwareOp({ principal: stranger, hardware: new HostHardwareService(s.services, s.manager) }),
    ])
      expect(await refused(op)).toMatchObject({ code: 'unauthorized' });
    expect(s.manager.host.joins).toEqual([]);
  });

  it('say `not_managed` where no manager knows the box, and can’t change anything there', async () => {
    expect(await hostNetworkOp(ctx(owner))).toEqual({ network: null, reason: 'not_managed' });
    expect(await hostWifiScanOp(ctx(owner))).toEqual({ scan: null, reason: 'not_managed' });
    expect(await hostHardwareOp({ principal: owner, hardware: undefined })).toEqual({
      hardware: null,
      reason: 'not_managed',
    });
    expect(await refused(hostWifiJoinOp(ctx(owner), { ssid: 'Home' }))).toMatchObject({
      code: 'not_implemented',
    });
  });

  it('answer the manager’s refusals on the session’s codes, the network’s own in `details.code`', async () => {
    const s = setup();
    const join = await hostWifiJoinOp(ctx(owner, s.network), { ssid: 'Home', passphrase: PASSPHRASE });
    expect(join.change.phase).toBe('applying');
    expect(s.records[0]).toMatchObject({ actorAccountId: 'acc_owner', endpointId: 'ep_owner' });
    const busy = await refused(hostWifiForgetOp(ctx(owner, s.network), { ssid: 'Office' }));
    expect(busy).toBeInstanceOf(SessionOpError);
    expect(busy).toMatchObject({ code: 'conflict', details: { code: 'busy' } });
    s.later(300);
    expect(await refused(hostWifiForgetOp(ctx(owner, s.network), { ssid: 'Nowhere' }))).toMatchObject({
      code: 'not_found',
      details: { code: 'not_saved' },
    });
    s.manager.host.cable.connected = false;
    expect(await refused(hostWifiForgetOp(ctx(owner, s.network), { ssid: 'Home' }))).toMatchObject({
      code: 'conflict',
      details: { code: 'in_use' },
    });
    s.manager.host.wifiMissing = 'disabled';
    expect(await refused(hostWifiForgetOp(ctx(owner, s.network), { ssid: 'Home' }))).toMatchObject({
      code: 'not_allowed',
      details: { code: 'no_wifi' },
    });
    s.manager.host.older = true;
    const older = await refused(hostWifiForgetOp(ctx(owner, s.network), { ssid: 'Home' }));
    expect(older).toMatchObject({ code: 'unavailable' });
    expect((older as SessionOpError).details).toBeUndefined();
  });

  it('give the hardware report to the person, `unavailable` after 10 seconds without an answer', async () => {
    const s = setup();
    const hardware = new HostHardwareService(s.services, s.manager);
    const out = await hostHardwareOp({ principal: owner, hardware });
    expect(out.hardware?.devices.find((d) => d.kind === 'wifi')?.driver).toBe('mt7925e');
    vi.useFakeTimers();
    const slow = new HostHardwareService(s.services, {
      hostHardware: () => new Promise(() => {}),
    } as unknown as ManagerPort);
    const answer = slow.read();
    await vi.advanceTimersByTimeAsync(HOST_HARDWARE_TIMEOUT_MS);
    expect(await answer).toEqual({ hardware: null, reason: 'unavailable' });
  });

  it('a refusal that isn’t the network’s stays what it is', async () => {
    const s = setup();
    // An SSID the contract refuses never reaches the manager (the op's schema refuses it first; here the service).
    const err = await refused(s.network.join({ ssid: '\u0007bell' }, { via: 'screen' }));
    expect(err).toBeInstanceOf(ApiError);
    expect(s.manager.host.joins).toEqual([]);
  });
});

describe('Wi-Fi only and the cable again (network-move.md NM-01, NM-02)', () => {
  it('asks for the 2-minute guard and records the change as the person’s', async () => {
    const s = setup();
    s.network.moves.close();
    const { change } = await hostCableSetOp({ principal: owner, network: s.network }, { use: 'wifi' });
    expect(change).toMatchObject({ use: 'wifi', by: 'person', phase: 'applying' });
    expect(s.manager.host.cableSets).toEqual([{ use: 'wifi', confirmTimeoutSec: WIFI_CONFIRM_TIMEOUT_S }]);
    expect(s.records).toEqual([
      expect.objectContaining({
        kind: 'cable',
        actorAccountId: 'acc_owner',
        endpointId: 'ep_owner',
        payload: { use: 'wifi', by: 'person', via: 'app', changeId: change.id },
      }),
    ]);
    s.later(400);
    const { network } = await s.network.read();
    expect(network).toMatchObject({ wifiOnly: true, cableChange: { id: change.id, phase: 'committed' } });
    expect(network?.wired[0]).toMatchObject({ plugged: true, connected: false });
  });

  it('answers the manager’s refusals on the session’s codes, the cable’s own in `details.code`', async () => {
    const s = setup();
    s.network.moves.close();
    const ctx = { principal: owner, network: s.network };
    expect(await refused(hostCableSetOp(ctx, { use: 'cable' }))).toMatchObject({
      code: 'conflict',
      details: { code: 'unchanged' },
    });
    s.manager.host.connected = null;
    expect(await refused(hostCableSetOp(ctx, { use: 'wifi' }))).toMatchObject({
      code: 'conflict',
      details: { code: 'not_connected' },
    });
    s.manager.host.wifiMissing = 'no_driver';
    expect(await refused(hostCableSetOp(ctx, { use: 'wifi' }))).toMatchObject({
      code: 'not_allowed',
      details: { code: 'no_wifi' },
    });
    s.manager.host.older = true;
    expect(await refused(hostCableSetOp(ctx, { use: 'wifi' }))).toMatchObject({ code: 'unavailable' });
    expect(s.records).toEqual([]);
    expect(
      await refused(hostCableSetOp({ principal: stranger, network: s.network }, { use: 'wifi' })),
    ).toBeInstanceOf(ApiError);
  });

  it('is one network change at a time, Wi-Fi or cable', async () => {
    const s = setup();
    s.network.moves.close();
    await s.network.join(
      { ssid: 'Home', passphrase: PASSPHRASE },
      { via: 'app', accountId: 'a', endpointId: null },
    );
    expect(
      await refused(hostCableSetOp({ principal: owner, network: s.network }, { use: 'wifi' })),
    ).toMatchObject({ details: { code: 'busy' } });
  });
});
