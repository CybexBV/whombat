/**
 * The Bluetooth service's socket client (bluetooth-server.md BT-S02) over a real unix socket: the paths, methods and
 * bodies of §2.3, answers checked against the contract, a refusal's status and code kept without its words (they may
 * name an address, BT-10), a whole-call deadline, and which failures did nothing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLUETOOTH_PATHS } from '@whombat/control-contracts/local';
import { afterEach, describe, expect, it } from 'vitest';
import { BluetoothCallError, BluetoothSocketClient, bluetoothRefused } from './bluetooth-client';
import { fakePairedDevices } from './fake-bluetooth';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function listen(handler: RequestListener): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-bt-'));
  const path = join(dir, 'bluetooth.sock');
  const server = createServer(handler);
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return path;
}

const [KEYBOARD] = fakePairedDevices();
const ADDRESS = KEYBOARD?.address ?? '';
const STATE = {
  adapter: { name: 'whombat', powered: true },
  devices: fakePairedDevices(),
  scan: null,
  pairing: null,
};
const PAIRING = {
  id: 'p-abcdefgh12',
  address: ADDRESS,
  name: 'Keychron K3',
  kind: 'keyboard',
  phase: 'pairing',
  deadline: '2026-10-20T12:01:30.000Z',
};

async function errorOf(p: Promise<unknown>): Promise<BluetoothCallError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BluetoothCallError);
  return err as BluetoothCallError;
}

describe('the Bluetooth socket client (BT-S02)', () => {
  it('asks each path with its method and body and reads the answers', async () => {
    const seen: { method?: string; url?: string; body: unknown }[] = [];
    const path = await listen(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      seen.push({ method: req.method, url: req.url, body: text ? JSON.parse(text) : null });
      const answers: Record<string, unknown> = {
        [BLUETOOTH_PATHS.state]: { v: 1, bluetooth: STATE },
        [BLUETOOTH_PATHS.scan]: { v: 1, scan: { until: '2026-10-20T12:01:00.000Z', devices: [] } },
        [BLUETOOTH_PATHS.pair]: { v: 1, pairing: PAIRING },
        [BLUETOOTH_PATHS.confirm]: { v: 1, pairing: { ...PAIRING, phase: 'connecting' } },
        [BLUETOOTH_PATHS.cancel]: { v: 1, pairing: { ...PAIRING, phase: 'failed', failure: 'canceled' } },
        [BLUETOOTH_PATHS.connect]: { v: 1, device: KEYBOARD },
        [BLUETOOTH_PATHS.disconnect]: { v: 1, device: { ...KEYBOARD, connected: false } },
        [BLUETOOTH_PATHS.forget]: { v: 1 },
      };
      res.writeHead(req.url === BLUETOOTH_PATHS.pair ? 202 : 200).end(JSON.stringify(answers[req.url ?? '']));
    });
    const client = new BluetoothSocketClient(path);
    expect((await client.state()).devices).toHaveLength(2);
    expect((await client.scan()).devices).toEqual([]);
    expect((await client.pair(ADDRESS)).id).toBe(PAIRING.id);
    expect((await client.confirm(PAIRING.id, true)).phase).toBe('connecting');
    expect((await client.cancel(PAIRING.id)).failure).toBe('canceled');
    expect((await client.connect(ADDRESS)).connected).toBe(true);
    expect((await client.disconnect(ADDRESS)).connected).toBe(false);
    await client.forget(ADDRESS);
    expect(seen).toEqual([
      { method: 'GET', url: BLUETOOTH_PATHS.state, body: null },
      { method: 'POST', url: BLUETOOTH_PATHS.scan, body: { v: 1 } },
      { method: 'POST', url: BLUETOOTH_PATHS.pair, body: { v: 1, address: ADDRESS } },
      { method: 'POST', url: BLUETOOTH_PATHS.confirm, body: { v: 1, pairingId: PAIRING.id, accept: true } },
      { method: 'POST', url: BLUETOOTH_PATHS.cancel, body: { v: 1, pairingId: PAIRING.id } },
      { method: 'POST', url: BLUETOOTH_PATHS.connect, body: { v: 1, address: ADDRESS } },
      { method: 'POST', url: BLUETOOTH_PATHS.disconnect, body: { v: 1, address: ADDRESS } },
      { method: 'POST', url: BLUETOOTH_PATHS.forget, body: { v: 1, address: ADDRESS } },
    ]);
  });

  it('keeps a refusal’s status and code, never its words', async () => {
    const path = await listen((_req, res) => {
      res.writeHead(409).end(JSON.stringify({ error: { code: 'busy', message: `${ADDRESS} is pairing` } }));
    });
    const err = await errorOf(new BluetoothSocketClient(path).pair(ADDRESS));
    expect(err).toMatchObject({ status: 409, code: 'busy', path: BLUETOOTH_PATHS.pair });
    expect(err.message).not.toContain(ADDRESS);
    expect(bluetoothRefused(err)).toBe(true);
  });

  it('refuses an answer outside the contract', async () => {
    const path = await listen((_req, res) => {
      res.end(JSON.stringify({ v: 1, bluetooth: { ...STATE, devices: [{ ...KEYBOARD, address: 'nope' }] } }));
    });
    const err = await errorOf(new BluetoothSocketClient(path).state());
    expect(err.code).toBe('invalid_answer');
    expect(bluetoothRefused(err)).toBe(false);
  });

  it('gives up on a service that doesn’t answer in time, which may have acted', async () => {
    const path = await listen(() => {
      /* never answers */
    });
    const client = new BluetoothSocketClient(path, { call: 50, connect: 50, drop: 50 });
    const err = await errorOf(client.state());
    expect(err).toMatchObject({ status: 0, code: 'unreachable' });
    expect(bluetoothRefused(err)).toBe(false);
  });

  it('says a socket nobody listens on did nothing', async () => {
    const err = await errorOf(new BluetoothSocketClient('/nonexistent/bluetooth.sock').forget(ADDRESS));
    expect(err).toMatchObject({ status: 0, code: 'unreachable' });
    expect(bluetoothRefused(err)).toBe(true);
  });
});
