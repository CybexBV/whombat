/**
 * The commands' proxy and the runner's control socket (one-person.md OP-S106): nothing goes through before the runner
 * set a policy; then CONNECT and plain http to what the wall allows, a refusal with its reason otherwise; names are
 * decided on their IPv4 addresses.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { type AddressInfo, connect, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlRequest, startControl } from './control';
import { decide, startProxy } from './proxy';
import { EMPTY_POLICY, type NetPolicy, type WallPolicy } from './rules';

const facts = { hostAddresses: [], deny: [] };

describe('the commands’ proxy', () => {
  let dir: string;
  let upstream: Server;
  let port = 0;
  let policy: NetPolicy | null = null;
  const closers: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wb-agent-net-'));
    upstream = createServer((_q, s) => s.end('hello from outside'));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    port = (upstream.address() as AddressInfo).port;
    // public.example stands for a public address; its dial lands on the local server.
    const proxy = await startProxy({
      path: join(dir, 'proxy.sock'),
      policy: () => policy,
      facts: () => facts,
      resolve4: async (h) => (h === 'public.example' ? ['93.184.216.34'] : ['10.0.0.1']),
      dial: () => ({ host: '127.0.0.1', port }),
    });
    const control = await startControl({
      path: join(dir, 'control.sock'),
      apply: (p) => {
        policy = p;
      },
      current: () => policy ?? EMPTY_POLICY,
    });
    closers.push(proxy.close, control.close);
  });

  afterAll(async () => {
    for (const c of closers) await c();
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (host: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        { socketPath: join(dir, 'proxy.sock'), path: `http://${host}/`, headers: { host } },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => {
            body += c.toString();
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });

  const tunnel = (authority: string) =>
    new Promise<string>((resolve) => {
      const s = connect(join(dir, 'proxy.sock'));
      let head = '';
      s.on('data', (c: Buffer) => {
        head += c.toString();
        if (head.includes('\r\n')) {
          s.destroy();
          resolve(head.split('\r\n')[0] ?? '');
        }
      });
      s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });

  it('lets nothing through before the runner set a policy', async () => {
    const r = await get('public.example');
    expect(r.status).toBe(403);
  });

  it('takes the policy on its control socket, then lets the wall decide', async () => {
    const answer = await controlRequest(join(dir, 'control.sock'), { op: 'policy', policy: EMPTY_POLICY });
    expect(answer.ok).toBe(true);
    expect(await get('public.example')).toEqual({ status: 200, body: 'hello from outside' });
    expect((await get('inside.example')).status).toBe(403);
    expect(await tunnel('public.example:443')).toMatch(/ 200 /);
    expect(await tunnel('public.example:25')).toMatch(/ 403 /);
    const status = await controlRequest(join(dir, 'control.sock'), { op: 'status' });
    expect(status).toEqual({ ok: true, policy: EMPTY_POLICY });
  });

  it('cuts a tunnel to a production server once its opening is gone, and leaves other tunnels alone', async () => {
    const echo = createTcpServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    const echoPort = (echo.address() as AddressInfo).port;
    const production = '93.184.216.35';
    let wall: WallPolicy = {
      ...EMPTY_POLICY,
      production: [production],
      open: [{ address: production, port: 22 }],
    };
    const proxy = await startProxy({
      path: join(dir, 'cut.sock'),
      policy: () => wall,
      facts: () => facts,
      dial: () => ({ host: '127.0.0.1', port: echoPort }),
      recheckMs: 10,
    });
    const open = (authority: string) =>
      new Promise<{ closed: Promise<void>; end: () => void }>((resolve) => {
        const s = connect(join(dir, 'cut.sock'));
        const closed = new Promise<void>((r) => s.once('close', () => r()));
        s.once('data', () => resolve({ closed, end: () => s.destroy() }));
        s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      });
    const toProduction = await open(`${production}:22`);
    const toPublic = await open('93.184.216.34:22');
    let publicClosed = false;
    void toPublic.closed.then(() => {
      publicClosed = true;
    });
    // The opening lapses (its time was up, or the runner removed it): the open tunnel goes too.
    wall = { ...wall, open: [] };
    await toProduction.closed;
    expect(publicClosed).toBe(false);
    toPublic.end();
    await proxy.close();
    echo.close();
  });

  it('closes while an ordinary tunnel is still open, and cuts that tunnel', async () => {
    const echo = createTcpServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    const echoPort = (echo.address() as AddressInfo).port;
    const proxy = await startProxy({
      path: join(dir, 'close.sock'),
      policy: () => EMPTY_POLICY,
      facts: () => facts,
      dial: () => ({ host: '127.0.0.1', port: echoPort }),
    });
    const s = connect(join(dir, 'close.sock'));
    const closed = new Promise<void>((r) => s.once('close', () => r()));
    await new Promise<void>((r) => {
      s.once('data', () => r());
      s.write('CONNECT 93.184.216.34:443 HTTP/1.1\r\nHost: 93.184.216.34:443\r\n\r\n');
    });
    const outcome = await Promise.race([
      proxy.close().then(() => 'closed'),
      new Promise<string>((r) => setTimeout(() => r('still open'), 2_000).unref()),
    ]);
    expect(outcome).toBe('closed');
    await closed;
    s.destroy();
    echo.close();
  });

  it('decides names on their IPv4 addresses and refuses IPv6', async () => {
    const resolve4 = async (h: string) =>
      h === 'mixed.example' ? ['10.0.0.1', '93.184.216.34'] : ['10.0.0.1'];
    expect(await decide('mixed.example', 443, EMPTY_POLICY, facts, resolve4)).toEqual({
      ok: true,
      address: '93.184.216.34',
    });
    expect((await decide('inside.example', 443, EMPTY_POLICY, facts, resolve4)).ok).toBe(false);
    expect((await decide('[2606:4700::1]', 443, EMPTY_POLICY, facts, resolve4)).ok).toBe(false);
    expect(await decide('localhost', 20001, EMPTY_POLICY, facts, resolve4)).toEqual({
      ok: true,
      address: '127.0.0.1',
    });
  });
});
