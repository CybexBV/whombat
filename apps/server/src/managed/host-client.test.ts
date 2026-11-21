/**
 * The manager socket client's hardware and network calls (hardware-support-server.md HD-S03) against the fake box on a
 * unix socket: the paths and `{v}` bodies of §2.4, the change's 202, the manager's refusals as `ManagerCallError` codes,
 * and an answer outside the contract refused.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostHardwareRequest,
  MANAGER_PATHS,
  NetworkStateRequest,
  WifiForgetRequest,
  WifiJoinRequest,
  WifiScanRequest,
} from '@whombat/control-contracts/local';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeHost } from './fake-host';
import { ManagerSocketClient } from './manager-client';
import { ManagerCallError } from './ports';

const dir = mkdtempSync(join(tmpdir(), 'mgr-host-'));
const path = join(dir, 'manager.sock');
const host = new FakeHost();
const asked: { path: string; body: unknown }[] = [];
let odd = false;
let server: Server;

/** The fake box behind §2.4's routes, refusing a body the contract doesn't allow as the manager does. */
function answer(url: string, body: unknown): { status: number; body: unknown } {
  if (odd) return { status: 200, body: { v: 1, network: { online: 'yes' } } };
  switch (url) {
    case MANAGER_PATHS.hostHardware:
      HostHardwareRequest.parse(body);
      return { status: 200, body: host.hostHardware() };
    case MANAGER_PATHS.networkState:
      NetworkStateRequest.parse(body);
      return { status: 200, body: host.networkState() };
    case MANAGER_PATHS.wifiScan:
      WifiScanRequest.parse(body);
      return { status: 200, body: host.wifiScan() };
    case MANAGER_PATHS.wifiJoin:
      return { status: 202, body: host.wifiJoin(WifiJoinRequest.parse(body)) };
    case MANAGER_PATHS.wifiForget:
      return { status: 202, body: host.wifiForget(WifiForgetRequest.parse(body)) };
    default:
      return { status: 404, body: { error: { code: 'not_found', message: 'no such route' } } };
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      asked.push({ path: req.url ?? '', body: { ...body, ...(body.passphrase ? { passphrase: '…' } : {}) } });
      let out: { status: number; body: unknown };
      try {
        out = answer(req.url ?? '', body);
      } catch (err) {
        out =
          err instanceof ManagerCallError
            ? { status: err.status, body: { error: { code: err.code, message: err.message } } }
            : { status: 400, body: { error: { code: 'bad_request', message: 'not valid' } } };
      }
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('the manager’s hardware and network routes (§2.4)', () => {
  const client = new ManagerSocketClient(path);

  it('reads the hardware, the network and a scan with `{v: 1}`', async () => {
    expect((await client.hostHardware()).hardware.cpu.threads).toBe(32);
    expect((await client.networkState()).network.wifi?.ssid).toBe('Office');
    expect((await client.wifiScan()).scan.networks.length).toBeGreaterThan(0);
    expect(asked.slice(-3)).toEqual([
      { path: MANAGER_PATHS.hostHardware, body: { v: 1 } },
      { path: MANAGER_PATHS.networkState, body: { v: 1 } },
      { path: MANAGER_PATHS.wifiScan, body: { v: 1 } },
    ]);
  });

  it('takes a change’s 202, and a refusal as its code', async () => {
    const { change } = await client.wifiJoin({
      v: 1,
      ssid: 'Home',
      passphrase: 'correct-horse-42',
      confirmTimeoutSec: 120,
    });
    expect(change).toMatchObject({ kind: 'join', phase: 'applying' });
    expect(asked.at(-1)).toEqual({
      path: MANAGER_PATHS.wifiJoin,
      body: { v: 1, ssid: 'Home', passphrase: '…', confirmTimeoutSec: 120 },
    });
    const busy = await client.wifiForget({ v: 1, ssid: 'Office' }).catch((err: unknown) => err);
    expect(busy).toBeInstanceOf(ManagerCallError);
    expect(busy).toMatchObject({ status: 409, code: 'busy' });
  });

  it('never sends what the contract doesn’t allow, and refuses an answer outside it', async () => {
    const before = asked.length;
    await expect(
      client.wifiJoin({ v: 1, ssid: 'Home', passphrase: 'short', confirmTimeoutSec: 120 }),
    ).rejects.toThrow();
    expect(asked.length).toBe(before);
    odd = true;
    await expect(client.networkState()).rejects.toThrow();
    odd = false;
  });
});
