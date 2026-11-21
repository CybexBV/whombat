/**
 * One smoke test against the real hosts service (one-whombat-servers.md ONE-DH20): `whombat-hosts serve --headless`
 * on a unix socket with a fresh service token, three simulated servers from `rackoon-sim` enrolled through it, and
 * Whombat's routes, mapping and event stream on top. Skipped unless `WHOMBAT_HOSTS_BIN` and `WHOMBAT_HOSTS_SIM` name the
 * built binaries (`go build -o … ./cmd/whombat-hosts ./cmd/rackoon-sim` in whombat-hosts).
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostFleet, HostServerDetail } from '@whombat/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusFrame } from '../realtime/bus';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { startHosts } from './index';

const BIN = process.env.WHOMBAT_HOSTS_BIN;
const SIM = process.env.WHOMBAT_HOSTS_SIM;
const present = Boolean(BIN && SIM && existsSync(BIN) && existsSync(SIM));
const dir = present ? mkdtempSync(join(tmpdir(), 'whombat-hosts-real-')) : '';
const socket = join(dir, 'api.sock');
const tokenFile = join(dir, 'service-token');

const t = present
  ? useTestServer({
      seed: true,
      listen: true,
      env: { WHOMBAT_HOSTS_SOCKET: socket, WHOMBAT_HOSTS_TOKEN_FILE: tokenFile },
    })
  : null;

const procs: ChildProcess[] = [];
const frames: BusFrame[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      s.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')),
      );
    });
  });
}

async function waitFor<T>(fn: () => T | Promise<T>, ms = 20_000): Promise<NonNullable<T>> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!present)('the real hosts service', () => {
  let cookie = '';
  const get = async (path: string) => {
    const res = await t?.api.inject({
      method: 'GET',
      url: `/api/v1/burrows/burrow-hq/hosts${path}`,
      headers: { cookie },
    });
    return { status: res?.statusCode ?? 0, body: res?.json() as Record<string, unknown> };
  };

  beforeAll(async () => {
    const port = await freePort();
    const agentUrl = `wss://127.0.0.1:${port}`;
    procs.push(
      spawn(
        BIN as string,
        [
          'serve',
          '--headless',
          '--data',
          join(dir, 'data'),
          '--listen',
          `unix:${socket}`,
          '--agent-listen',
          `127.0.0.1:${port}`,
          '--agent-url',
          agentUrl,
          '--service-token-file',
          tokenFile,
        ],
        { stdio: 'ignore' },
      ),
    );
    await waitFor(() => existsSync(socket) && existsSync(tokenFile));
    const services = t?.services;
    if (!services) throw new Error('no server');
    cookie = (await sessionFor(services, IDS.mara)).cookie;
    const hub = await waitFor(async () => {
      const s = await get('/status');
      return s.body.healthy ? s.body : null;
    });
    expect(hub.agentUrl).toBe(agentUrl);
    services.bus.onFrame((f) => {
      if (f.topic.startsWith('hosts:')) frames.push(f);
    });
    startHosts(services);
    const ca = JSON.parse(
      execFileSync(
        'curl',
        [
          '-s',
          '--unix-socket',
          socket,
          '-H',
          `Authorization: Bearer ${readFileSync(tokenFile, 'utf8').trim()}`,
          'http://hosts/api/v1/hub',
        ],
        { encoding: 'utf8' },
      ),
    ).ca_sha256 as string;
    procs.push(
      spawn(
        SIM as string,
        [
          '--ui',
          `unix:${socket}`,
          '--service-token-file',
          tokenFile,
          '--agent-url',
          agentUrl,
          '--ca-sha256',
          ca,
          '--n',
          '3',
          '--interval',
          '2s',
          '--history',
          '30m',
          '--offline-after',
          '0',
          '--state',
          join(dir, 'sim'),
        ],
        { stdio: 'ignore' },
      ),
    );
  }, 60_000);

  afterAll(() => {
    for (const p of procs) p.kill('SIGTERM');
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('shows the simulated servers through Whombat, mapped to the contract, with live frames', async () => {
    const fleet = await waitFor(async () => {
      const f = await get('/fleet');
      return (f.body.servers as unknown[] | undefined)?.length === 3 ? f.body : null;
    }, 30_000);
    expect(HostFleet.safeParse(fleet).error).toBeUndefined();
    const detail = await get('/servers/basalt');
    expect(detail.status).toBe(200);
    expect(HostServerDetail.safeParse(detail.body).error).toBeUndefined();
    const metrics = await get('/servers/basalt/metrics?range=1h');
    expect(metrics.status).toBe(200);
    await waitFor(() => frames.find((f) => f.event.type === 'hosts.server'), 30_000);
  }, 90_000);
});
