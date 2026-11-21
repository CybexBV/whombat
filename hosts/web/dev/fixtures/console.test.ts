// Console WebSocket against a real HTTP server (upgrade handling, frames,
// fake shell, single-use tokens, audit and SSE on close).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AuditPage, ConsoleSession } from '../../src/api/types';
import { createConsoleServer, parseRelay } from './console';
import { decodeFrame, encodeControl, encodeFrame, FRAME_CONTROL, FRAME_DATA, parseControl } from './frames';
import { FixtureStore } from './state';
import { browser } from './testkit';

const store = new FixtureStore();
let idleS = 900;
const consoles = createConsoleServer(store, { idleS: () => idleS });
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((_req, res) => res.end());
  server.on('upgrade', (req, socket, head) => {
    if (!consoles.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  consoles.close();
  await new Promise((r) => server.close(r));
});

interface Client {
  ws: WebSocket;
  controls: Record<string, unknown>[];
  output: () => string;
  waitFor: (pred: () => boolean, ms?: number) => Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
}

function connect(s: ConsoleSession, protocols = ['rackoon.console.v1', `rackoon.token.${s.token}`]): Promise<Client | { status: number; body: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${s.url}`, protocols);
    const controls: Record<string, unknown>[] = [];
    let out = '';
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    ws.on('message', (data: Buffer) => {
      const f = decodeFrame(Buffer.from(data));
      if (f?.kind === FRAME_CONTROL) controls.push({ ...parseControl(f.payload) });
      else if (f?.kind === FRAME_DATA) out += f.payload.toString('utf8');
    });
    const waitFor = async (pred: () => boolean, ms = 2000) => {
      const end = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > end) throw new Error(`timeout; output so far: ${JSON.stringify(out)}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    ws.on('open', () => resolve({ ws, controls, output: () => out.replace(/\x1b\[[0-9;]*m/g, ''), waitFor, closed }));
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
  });
}

const isClient = (c: Client | { status: number }): c is Client => 'ws' in c;
const type = (ws: WebSocket, text: string) => ws.send(encodeFrame(FRAME_DATA, 0, Buffer.from(text)));

describe('console WebSocket', () => {
  it('shell session: status, prompt, commands, pong, Ctrl+D closes with "ended"', async () => {
    const b = browser(store);
    const s = b.call('POST', '/servers/basalt/guests/incus%3Adev-shell/console-sessions', {}).json as ConsoleSession;
    const c = await connect(s);
    if (!isClient(c)) throw new Error(`refused ${c.status}`);
    expect(c.ws.protocol).toBe('rackoon.console.v1');
    await c.waitFor(() => c.output().endsWith('[jdoe@dev-shell:~/src/fleet-agent]$ '));
    expect(c.controls[0]).toEqual({ type: 'status', state: 'connected', protocol: 'shell', resolution: '80x24' });

    c.ws.send(encodeControl({ type: 'resize', cols: 120, rows: 40 }));
    c.ws.send(encodeControl({ type: 'ping', id: 42 }));
    type(c.ws, 'stty size\r');
    await c.waitFor(() => c.output().includes('40 120\r\n') && c.controls.some((x) => x.type === 'pong'));
    expect(c.controls.find((x) => x.type === 'pong')).toEqual({ type: 'pong', id: 42 });

    type(c.ws, '\x04');
    const closed = await c.closed;
    expect(closed).toEqual({ code: 1000, reason: 'ended' });
    expect(c.output()).toContain('logout\r\n');
    expect(c.controls.at(-1)).toEqual({ type: 'closed', reason: 'ended' });

    const st = store.states.get(b.id)!;
    expect(st.sessions.size).toBe(0);
    expect(st.events.backlog.at(-1)).toMatchObject({ name: 'console.closed', data: JSON.stringify({ session_id: s.session_id, reason: 'ended' }) });
    const audit = (b.call('GET', '/audit?event=console.&limit=3').json as AuditPage).items;
    expect(audit.map((r) => r.event)).toEqual(['console.closed', 'console.opened', 'console.requested']);
    expect(audit[0]).toMatchObject({ code: 'ended', protocol: 'shell', guest: 'incus:dev-shell', bytes_in: 11 });
    expect(audit[0]!.bytes_out).toBeGreaterThan(100);
  });

  it('tokens are single use and need both subprotocols', async () => {
    const b = browser(store);
    const s = b.call('POST', '/servers/shale/guests/pve%3A203/console-sessions', { protocol: 'tty' }).json as ConsoleSession;
    expect(await connect(s, ['rackoon.console.v1'])).toMatchObject({ status: 400 });
    expect(await connect(s, ['rackoon.console.v1', 'rackoon.token.wrong'])).toMatchObject({ status: 403 });
    const c = await connect(s);
    if (!isClient(c)) throw new Error('refused');
    await c.waitFor(() => c.output().endsWith('pihole login: '));
    const again = await connect(s);
    expect(again).toMatchObject({ status: 403 });
    expect((again as { body: string }).body).toContain('token_used');
    // DELETE /console-sessions/{id} ends a live session (reason "revoked").
    b.call('DELETE', `/console-sessions/${s.session_id}`);
    expect(await c.closed).toEqual({ code: 1000, reason: 'revoked' });
  });

  it('VNC without a relay answers fixture_mode and closes', async () => {
    const b = browser(store);
    const s = b.call('POST', '/servers/basalt/guests/libvirt%3Aopnsense/console-sessions', {}).json as ConsoleSession;
    expect(s.protocol).toBe('vnc');
    const c = await connect(s);
    if (!isClient(c)) throw new Error('refused');
    expect(await c.closed).toEqual({ code: 1000, reason: 'fixture_mode' });
    expect(c.controls).toEqual([{ type: 'error', code: 'fixture_mode', message: 'VNC is not available in fixture mode. Run against a hub (pnpm dev) to use graphical consoles.' }]);
  });

  it('simulate-drop terminates without a closed control', async () => {
    const b = browser(store);
    const s = b.call('POST', '/servers/shale/guests/pve%3A203/console-sessions', {}).json as ConsoleSession;
    const c = await connect(s);
    if (!isClient(c)) throw new Error('refused');
    await c.waitFor(() => c.output().endsWith('# '));
    type(c.ws, 'simulate-drop\r');
    expect((await c.closed).code).toBe(1006);
    expect(c.controls.map((x) => x.type)).toEqual(['status']);
  });
});

describe('console timeouts', () => {
  it('closes with idle_timeout when the browser sends nothing', async () => {
    idleS = 0.3;
    try {
      const b = browser(store);
      const s = b.call('POST', '/servers/shale/guests/pve%3A200/console-sessions', {}).json as ConsoleSession;
      const c = await connect(s);
      if (!isClient(c)) throw new Error('refused');
      expect(await c.closed).toEqual({ code: 1000, reason: 'idle_timeout' });
      expect(c.controls.at(-1)).toEqual({ type: 'closed', reason: 'idle_timeout' });
    } finally {
      idleS = 900;
    }
  });
});

describe('FIXTURE_CONSOLE_RELAY', () => {
  it('parses protocol=host:port pairs', () => {
    expect([...parseRelay('vnc=127.0.0.1:5900, spice=[::1]:5930,bogus')]).toEqual([
      ['vnc', { host: '127.0.0.1', port: 5900 }],
      ['spice', { host: '::1', port: 5930 }],
    ]);
    expect(parseRelay(undefined).size).toBe(0);
  });
});
