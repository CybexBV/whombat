/**
 * The screen and the box's Bluetooth (bluetooth.md BT-02; bluetooth-server.md BT-S06): the may-change rule, and the desk
 * socket's Bluetooth routes over a real unix socket — the paired devices always, every change only before the claim or
 * while the screen is unlocked, decided again on every change, `no_adapter` / `no_bluetooth` without a service.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESK_PATHS as PATHS } from '@whombat/control-contracts/local';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeBluetooth } from '../managed/fake-bluetooth';
import { type BluetoothRecord, HostBluetoothService } from '../managed/host-bluetooth';
import type { Services } from '../services';
import { type DeskBluetoothHost, DeskBluetoothRoutes, deskMayChangeBluetooth } from './bluetooth';
import { type DeskPort, DeskSocket } from './socket';

const MOUSE = 'D4:3A:2C:91:7E:0B';
const SONY = '88:C9:E8:3B:20:5F';

describe('may the screen change the Bluetooth (BT-02)', () => {
  it('only before the claim or while it is unlocked', () => {
    const cases: [boolean, boolean, boolean][] = [
      // claimed, unlocked → may change
      [false, false, true],
      [false, true, true],
      [true, true, true],
      [true, false, false],
    ];
    for (const [claimed, unlocked, may] of cases) {
      const answer = deskMayChangeBluetooth({ claimed, unlocked });
      expect(answer.mayChange, JSON.stringify({ claimed, unlocked })).toBe(may);
      expect(answer.why).toBe(may ? undefined : 'locked');
    }
  });
});

const dir = mkdtempSync(join(tmpdir(), 'desk-bt-'));
const path = join(dir, 'desk.sock');
let now = Date.parse('2026-10-20T12:00:00.000Z');
const records: BluetoothRecord[] = [];
const box = { claimed: true, unlocked: false, touches: 0 };
const services = {
  clock: () => new Date(now),
  config: { WHOMBAT_CONSOLE_GROUP: 'whombat-console-test-none', NODE_ENV: 'test' },
  log: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
} as unknown as Services;
let fake = new FakeBluetooth(() => now, { stepMs: 100 });
const host: DeskBluetoothHost = {
  bluetooth: null,
  claimed: async () => box.claimed,
  unlocked: () => box.unlocked,
  touch: () => {
    box.touches += 1;
  },
};
const socket = new DeskSocket(services, {} as DeskPort, [new DeskBluetoothRoutes(host)]);

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
const post = (url: string, body: Record<string, unknown> = {}) => call('POST', url, { v: 1, ...body });

beforeAll(async () => {
  await socket.listen(path);
});

afterAll(async () => {
  await socket.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  now += 3_600_000;
  fake = new FakeBluetooth(() => now, { stepMs: 100 });
  host.bluetooth = new HostBluetoothService(services, fake, {
    record: async (r) => {
      records.push(r);
    },
    after: () => () => {},
  });
  Object.assign(box, { claimed: true, unlocked: false, touches: 0 });
  records.length = 0;
});

describe('the desk socket’s Bluetooth routes (BT-S06)', () => {
  it('shows the paired devices on a locked screen and says why it can’t change them', async () => {
    const r = await call('GET', PATHS.bluetooth);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ v: 1, mayChange: false, why: 'locked' });
    expect((r.json as { bluetooth: { devices: unknown[] } }).bluetooth.devices).toHaveLength(2);
    box.unlocked = true;
    expect((await call('GET', PATHS.bluetooth)).json).toMatchObject({ mayChange: true });
    expect(((await call('GET', PATHS.bluetooth)).json as { why?: string }).why).toBeUndefined();
  });

  it('refuses every change on a locked screen of a claimed box, before asking the service', async () => {
    for (const [url, body] of [
      [PATHS.bluetoothScan, {}],
      [PATHS.bluetoothPair, { address: MOUSE }],
      [PATHS.bluetoothConfirm, { pairingId: 'p-abcdefgh12', accept: true }],
      [PATHS.bluetoothCancel, { pairingId: 'p-abcdefgh12' }],
      [PATHS.bluetoothConnect, { address: SONY }],
      [PATHS.bluetoothDisconnect, { address: SONY }],
      [PATHS.bluetoothForget, { address: SONY }],
    ] as const) {
      const r = await post(url, body);
      expect([url, r.status, codeOf(r)]).toEqual([url, 409, 'locked']);
    }
    expect(fake.calls).toEqual([]);
    expect(box.touches).toBe(0);
  });

  it('pairs from the screen before the claim, records it as the screen’s and keeps the screen unlocked', async () => {
    box.claimed = false;
    const scan = await post(PATHS.bluetoothScan);
    expect(scan.status).toBe(200);
    expect((scan.json as { scan: { devices: { name: string }[] } }).scan.devices[0]?.name).toBe(
      'MX Master 3S',
    );
    const pair = await post(PATHS.bluetoothPair, { address: MOUSE });
    expect(pair.status).toBe(200);
    expect(pair.json).toMatchObject({ v: 1, pairing: { phase: 'pairing', kind: 'mouse' } });
    now += 200;
    expect(
      ((await call('GET', PATHS.bluetooth)).json as { bluetooth: { pairing: { phase: string } } }).bluetooth
        .pairing.phase,
    ).toBe('done');
    expect(records).toEqual([
      expect.objectContaining({
        kind: 'paired',
        actorAccountId: null,
        payload: expect.objectContaining({ via: 'screen' }),
      }),
    ]);
    expect(box.touches).toBe(2);
  });

  it('connects, disconnects and removes from an unlocked screen', async () => {
    box.unlocked = true;
    expect((await post(PATHS.bluetoothConnect, { address: SONY })).json).toMatchObject({
      device: { connected: true },
    });
    expect((await post(PATHS.bluetoothDisconnect, { address: SONY })).json).toMatchObject({
      device: { connected: false },
    });
    expect(await post(PATHS.bluetoothForget, { address: SONY })).toEqual({ status: 200, json: { v: 1 } });
    expect(records.map((r) => [r.kind, r.payload.name, r.payload.via])).toEqual([
      ['removed', 'WH-1000XM5', 'screen'],
    ]);
    expect(box.touches).toBe(3);
  });

  it('passes the service’s refusals on with their statuses', async () => {
    box.unlocked = true;
    expect(codeOf(await post(PATHS.bluetoothPair, { address: MOUSE }))).toBe('not_found');
    await post(PATHS.bluetoothScan);
    now += 5_000;
    const notPaired = await post(PATHS.bluetoothConnect, { address: '7C:C1:80:5D:44:E2' });
    expect([notPaired.status, codeOf(notPaired)]).toEqual([409, 'not_paired']);
    await post(PATHS.bluetoothPair, { address: MOUSE });
    const busy = await post(PATHS.bluetoothPair, { address: '7C:C1:80:5D:44:E2' });
    expect([busy.status, codeOf(busy)]).toEqual([409, 'busy']);
    const looking = await post(PATHS.bluetoothScan);
    expect([looking.status, codeOf(looking)]).toEqual([409, 'busy']);
    fake.missing = 'disabled';
    const off = await post(PATHS.bluetoothScan);
    expect([off.status, codeOf(off)]).toEqual([409, 'no_bluetooth']);
    fake.down = true;
    expect((await call('GET', PATHS.bluetooth)).status).toBe(503);
    const down = await post(PATHS.bluetoothForget, { address: SONY });
    expect([down.status, codeOf(down)]).toEqual([503, 'unavailable']);
  });

  it('answers a box without a Bluetooth service: no adapter, and every change no_bluetooth', async () => {
    host.bluetooth = null;
    box.claimed = false;
    expect((await call('GET', PATHS.bluetooth)).json).toEqual({
      v: 1,
      bluetooth: { adapter: null, missing: 'no_adapter', devices: [], scan: null, pairing: null },
      mayChange: true,
    });
    const r = await post(PATHS.bluetoothScan);
    expect([r.status, codeOf(r)]).toEqual([409, 'no_bluetooth']);
  });

  it('refuses bodies the contract doesn’t allow and wrong methods', async () => {
    box.unlocked = true;
    expect(codeOf(await post(PATHS.bluetoothPair, { address: 'd4:3a:2c:91:7e:0b' }))).toBe('bad_request');
    expect(codeOf(await post(PATHS.bluetoothScan, { extra: true }))).toBe('bad_request');
    expect((await call('POST', PATHS.bluetooth, { v: 1 })).status).toBe(404);
    expect((await call('GET', PATHS.bluetoothScan)).status).toBe(404);
    expect(fake.calls).toEqual([]);
  });
});
