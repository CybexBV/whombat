/**
 * The screen and the box's Wi-Fi (hardware-support.md HD-07; hardware-support-server.md HD-S07): the may-change rule,
 * and the desk socket's network routes over a real unix socket — the network and scans always, a join or forget only
 * before the claim, while the box can't reach Whombat or while the screen is unlocked, decided again on every change.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESK_PATHS, DeskNetworkAnswer } from '@whombat/control-contracts/local';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeHost } from '../managed/fake-host';
import { HostNetworkService, type NetworkRecord } from '../managed/host-network';
import { FakeManager } from '../managed/testing';
import type { Services } from '../services';
import { DeskNetworkRoutes, deskMayChangeNetwork } from './network';
import { type DeskPort, DeskSocket } from './socket';

describe('may the screen change the Wi-Fi (HD-07)', () => {
  it('only before the claim, while the box can’t reach Whombat, or while it is unlocked', () => {
    const cases: [boolean, boolean, boolean, boolean][] = [
      // claimed, online, unlocked → may change
      [false, true, false, true],
      [true, false, false, true],
      [true, true, true, true],
      [true, true, false, false],
      [false, false, false, true],
    ];
    for (const [claimed, online, unlocked, may] of cases) {
      const answer = deskMayChangeNetwork({ claimed, online, unlocked });
      expect(answer.mayChange, JSON.stringify({ claimed, online, unlocked })).toBe(may);
      expect(answer.why).toBe(may ? undefined : 'locked');
    }
  });
});

const dir = mkdtempSync(join(tmpdir(), 'desk-net-'));
const path = join(dir, 'desk.sock');
let now = Date.parse('2026-10-20T12:00:00.000Z');
const manager = new FakeManager();
const records: NetworkRecord[] = [];
const box = { claimed: true, unlocked: false, touches: 0, claimAsked: 0 };
const services = {
  clock: () => new Date(now),
  config: { WHOMBAT_CONSOLE_GROUP: 'whombat-console-test-none', NODE_ENV: 'test' },
  log: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
} as unknown as Services;
const network = new HostNetworkService(services, manager, async (r) => {
  records.push(r);
});
const routes = new DeskNetworkRoutes({
  network,
  claimed: async () => {
    box.claimAsked += 1;
    return box.claimed;
  },
  unlocked: () => box.unlocked,
  touch: () => {
    box.touches += 1;
  },
});
const socket = new DeskSocket(services, {} as DeskPort, [routes]);

function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = request(
      {
        socketPath: path,
        method,
        path: url,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }),
        );
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

const codeOf = (r: { json: unknown }) => (r.json as { error?: { code?: string } }).error?.code;
const join_ = (ssid: string, passphrase?: string) =>
  call('POST', DESK_PATHS.wifiJoin, { v: 1, ssid, ...(passphrase ? { passphrase } : {}) });

beforeAll(async () => {
  await socket.listen(path);
});

afterAll(async () => {
  await socket.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  now += 3_600_000;
  manager.host = new FakeHost(() => now, { applyMs: 100, confirmMs: 200, keepMs: 1_000 });
  Object.assign(box, { claimed: true, unlocked: false, touches: 0, claimAsked: 0 });
  records.length = 0;
});

describe('the desk socket’s network routes (HD-S07)', () => {
  it('shows the network on a locked screen of a claimed box that works, and says why it can’t change it', async () => {
    const r = await call('GET', DESK_PATHS.network);
    expect(r.status).toBe(200);
    expect(DeskNetworkAnswer.parse(r.json)).toMatchObject({
      mayChange: false,
      why: 'locked',
      network: { online: true, wifi: { ssid: 'Office' } },
    });
  });

  it('lets the screen change it before the claim, while offline and while unlocked', async () => {
    box.claimed = false;
    expect(DeskNetworkAnswer.parse((await call('GET', DESK_PATHS.network)).json).mayChange).toBe(true);
    box.claimed = true;
    manager.host.controlReachable = false;
    const offline = DeskNetworkAnswer.parse((await call('GET', DESK_PATHS.network)).json);
    expect(offline).toMatchObject({ mayChange: true, network: { online: false } });
    expect(offline.why).toBeUndefined();
    manager.host.controlReachable = true;
    box.unlocked = true;
    const asked = box.claimAsked;
    expect(DeskNetworkAnswer.parse((await call('GET', DESK_PATHS.network)).json).mayChange).toBe(true);
    // Unlocked decides it: the claim isn't read.
    expect(box.claimAsked).toBe(asked);
  });

  it('scans whatever the lock says', async () => {
    const r = await call('POST', DESK_PATHS.wifiScan, { v: 1 });
    expect(r.status).toBe(200);
    expect((r.json as { scan: { networks: { ssid: string }[] } }).scan.networks[0]?.ssid).toBe('Home');
    manager.host.wifiMissing = 'disabled';
    expect(codeOf(await call('POST', DESK_PATHS.wifiScan, { v: 1 }))).toBe('no_wifi');
  });

  it('refuses a join or forget on a locked screen of a claimed box that works, and asks nothing of the manager', async () => {
    const r = await join_('Home', 'correct-horse-42');
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe('locked');
    expect(codeOf(await call('POST', DESK_PATHS.wifiForget, { v: 1, ssid: 'Office' }))).toBe('locked');
    expect(manager.host.joins).toEqual([]);
    expect(manager.host.forgets).toEqual([]);
  });

  it('joins from an unlocked screen, keeps it unlocked and records it as the screen’s', async () => {
    box.unlocked = true;
    const r = await join_('Home', 'correct-horse-42');
    expect(r.status).toBe(200);
    const change = (r.json as { v: 1; change: { id: string; phase: string } }).change;
    expect(change.phase).toBe('applying');
    expect(box.touches).toBe(1);
    expect(records).toEqual([
      expect.objectContaining({
        kind: 'join',
        actorAccountId: null,
        payload: { ssid: 'Home', via: 'screen', changeId: change.id },
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain('correct-horse-42');
    // The next one while it runs is the manager's `busy`.
    expect(codeOf(await call('POST', DESK_PATHS.wifiForget, { v: 1, ssid: 'Office' }))).toBe('busy');
  });

  it('joins on a box that can’t reach Whombat, locked or not (someone could plug in a cable anyway)', async () => {
    manager.host.controlReachable = false;
    const r = await join_('Home', 'correct-horse-42');
    expect(r.status).toBe(200);
    expect(manager.host.joins.map((j) => j.ssid)).toEqual(['Home']);
  });

  it('says which part of a join is wrong, and the manager’s refusals with their codes', async () => {
    box.unlocked = true;
    const short = await join_('Home', 'short');
    expect([short.status, codeOf(short)]).toEqual([400, 'invalid_passphrase']);
    const odd = await call('POST', DESK_PATHS.wifiJoin, { v: 1, ssid: '' });
    expect([odd.status, codeOf(odd)]).toEqual([400, 'bad_request']);
    const notSaved = await call('POST', DESK_PATHS.wifiForget, { v: 1, ssid: 'Home' });
    expect([notSaved.status, codeOf(notSaved)]).toEqual([404, 'not_saved']);
    manager.host.cable.connected = false;
    const inUse = await call('POST', DESK_PATHS.wifiForget, { v: 1, ssid: 'Office' });
    expect([inUse.status, codeOf(inUse)]).toEqual([409, 'in_use']);
    expect(manager.host.joins).toEqual([]);
  });

  it('is unavailable when the manager doesn’t know the network yet', async () => {
    manager.host.older = true;
    const r = await call('GET', DESK_PATHS.network);
    expect([r.status, codeOf(r)]).toEqual([503, 'unavailable']);
    box.unlocked = true;
    const j = await join_('Home', 'correct-horse-42');
    expect([j.status, codeOf(j)]).toEqual([503, 'unavailable']);
    // A claimed box whose network can't be read doesn't let a locked screen change it either.
    box.unlocked = false;
    expect(codeOf(await join_('Home', 'correct-horse-42'))).toBe('unavailable');
  });

  it('leaves the desk’s own routes and methods alone', async () => {
    expect((await call('POST', DESK_PATHS.network, { v: 1 })).status).toBe(404);
    expect((await call('GET', DESK_PATHS.wifiScan)).status).toBe(404);
  });
});
