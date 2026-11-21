/**
 * The agent's CDP relay (hermes-engine.md HE-S137…HE-S140, one-person.md OP-S113) against a stand-in host: Chromium's
 * start runs here with bash, the commands' network is this host's loopback, Chromium a small DevTools server of the
 * test's that answers as Chromium does.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import type { DispatchContext } from '@whombat/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Browser,
  type BrowserHost,
  browserOf,
  ClientFrames,
  chromiumCommand,
  closingHead,
  devtoolsPort,
  hasChromium,
  parseHead,
  passes,
  refusedCommand,
  siteAllows,
  turnBrowserPlan,
} from './browser';

/** A host whose Chromium is `devtools` (its start prints the line); its connections are this host's loopback. */
class StandInHost implements BrowserHost {
  // The image's bash, as on an appliance (no /bin/bash there).
  readonly shell = '/nix/store/tools/bin/bash';
  starts = 0;
  connections = 0;
  constructor(
    private readonly devtools: () => number,
    private readonly mode: 'ok' | 'none' = 'ok',
  ) {}
  async start(argv: readonly string[]): Promise<Socket> {
    expect(argv.slice(0, 2)).toEqual([this.shell, '-c']);
    this.starts++;
    const line =
      this.mode === 'ok'
        ? `echo '[1:1:ERROR:dbus/bus.cc] noise' >&2; echo 'DevTools listening on ws://127.0.0.1:${this.devtools()}/devtools/browser/b-1' >&2; sleep 30`
        : `echo 'whombat: no Chromium here' >&2; exit 127`;
    const child = spawn('bash', ['-c', line], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stream = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        child.stdin.write(chunk, cb);
      },
      destroy(_err, cb) {
        child.kill('SIGKILL');
        cb(null);
      },
    });
    child.stdout.on('data', (d: Buffer) => stream.push(d));
    child.stderr.on('data', (d: Buffer) => stream.push(d));
    child.on('close', () => {
      stream.push(null);
      stream.destroy();
    });
    child.stdin.on('error', () => {});
    return stream as unknown as Socket;
  }
  connect(port: number): Socket {
    this.connections++;
    return connect(port, '127.0.0.1');
  }
}

/** A DevTools server as Chromium answers: `/json/version` by the request's Host, a WebSocket that answers each command. */
async function standInDevtools(heard: string[]): Promise<HttpServer> {
  const server = createHttpServer((req, res) => {
    heard.push(`${req.method} ${req.url} ${req.headers.connection ?? ''}`);
    if (req.url === '/json/version')
      return res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ webSocketDebuggerUrl: `ws://${req.headers.host}/devtools/browser/b-1` }));
    res.writeHead(404).end();
  });
  const upgraded = new Set<Socket>();
  const close = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    for (const s of upgraded) s.destroy();
    server.closeAllConnections();
    return close(cb);
  }) as typeof server.close;
  server.on('upgrade', (req, socket: Socket) => {
    upgraded.add(socket);
    socket.once('close', () => upgraded.delete(socket));
    const key = String(req.headers['sec-websocket-key']);
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const frames = new ClientFrames(
      (text) => {
        if (text === null) return null;
        heard.push(text);
        const { id, method } = JSON.parse(text) as { id: number; method: string };
        const body = Buffer.from(JSON.stringify({ id, result: { did: method } }));
        socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
        return null;
      },
      () => {},
      () => {},
      () => socket.destroy(),
    );
    socket.on('data', (d: Buffer) => frames.push(d));
    socket.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

/** The sandbox's bridge standing in: a loopback port to the relay's socket. */
async function bridge(socketPath: string): Promise<Server> {
  const open = new Set<Socket>();
  const server = createServer((c) => {
    open.add(c);
    c.once('close', () => open.delete(c));
    const up = connect(socketPath);
    c.pipe(up);
    up.pipe(c);
    const done = () => {
      c.destroy();
      up.destroy();
    };
    c.on('error', done);
    up.on('error', done);
    c.on('close', done);
    up.on('close', done);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const close = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    for (const s of open) s.destroy();
    return close(cb);
  }) as typeof server.close;
  return server;
}

const portOf = (s: Server | HttpServer) => (s.address() as { port: number }).port;

/** One CDP command over a WebSocket: its answer. */
async function cdp(url: string, messages: object[]): Promise<unknown[]> {
  const ws = new WebSocket(url);
  const answers: unknown[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.onerror = () => reject(new Error('websocket error'));
    ws.onopen = () => {
      for (const m of messages) ws.send(JSON.stringify(m));
    };
    ws.onmessage = (e) => {
      answers.push(JSON.parse(String(e.data)));
      if (answers.length === messages.length) resolve();
    };
  });
  ws.close();
  return answers;
}

describe('the CDP relay of a turn’s browser (HE-S137…HE-S140)', () => {
  const closing: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of closing.splice(0).reverse()) await c();
  });

  async function setUp(sites: string[] | null, start: 'ok' | 'none' = 'ok') {
    const heard: string[] = [];
    const devtools = await standInDevtools(heard);
    closing.push(() => new Promise((r) => devtools.close(r)));
    const host = new StandInHost(() => portOf(devtools), start);
    const browser = await Browser.open(
      {
        host,
        socket: join(mkdtempSync(join(tmpdir(), 'wb-cdp-')), 'cdp.sock'),
        log: () => {},
        startMs: 5000,
      },
      { name: 'test', sites },
    );
    closing.push(() => browser.close());
    const front = await bridge(browser.socket);
    closing.push(() => new Promise((r) => front.close(r)));
    return { heard, host, browser, origin: `127.0.0.1:${portOf(front)}` };
  }

  it('starts Chromium for the first connection, once, and relays DevTools to it', async () => {
    const { heard, host, origin } = await setUp(null);
    expect(host.starts).toBe(0);
    const version = (await (await fetch(`http://${origin}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    // Chromium's own answer, its address the bridge's: the client comes back through the relay.
    expect(version.webSocketDebuggerUrl).toBe(`ws://${origin}/devtools/browser/b-1`);
    expect(heard[0]).toBe('GET /json/version close');
    const answers = await cdp(version.webSocketDebuggerUrl, [{ id: 1, method: 'Target.getTargets' }]);
    expect(answers).toEqual([{ id: 1, result: { did: 'Target.getTargets' } }]);
    expect(host.starts).toBe(1);
    // One connection into the commands' network per connection to the relay.
    expect(host.connections).toBe(2);
  });

  it('refuses what isn’t DevTools', async () => {
    const { host, origin } = await setUp(null);
    expect((await fetch(`http://${origin}/devtools/inspector.html`)).status).toBe(404);
    expect((await fetch(`http://${origin}/`)).status).toBe(404);
    expect(host.starts).toBe(0);
  });

  it('says why when Chromium can’t start, and tries again on the next connection', async () => {
    const { host, origin } = await setUp(null, 'none');
    const res = await fetch(`http://${origin}/json/version`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('no Chromium here');
    await fetch(`http://${origin}/json/version`);
    expect(host.starts).toBe(2);
  });

  it('keeps an assessment’s browser to the reported website (FB-28, HE-S140)', async () => {
    const { heard, origin } = await setUp(['example.com']);
    expect((await fetch(`http://${origin}/json/new?file:///etc/passwd`, { method: 'PUT' })).status).toBe(404);
    const answers = await cdp(`ws://${origin}/devtools/browser/b-1`, [
      { id: 1, method: 'Page.navigate', params: { url: 'https://www.example.com/pricing' }, sessionId: 's1' },
      { id: 2, method: 'Page.navigate', params: { url: 'https://elsewhere.test/' }, sessionId: 's1' },
      { id: 3, method: 'Target.createTarget', params: { url: 'file:///home/agent/work/notes.txt' } },
      { id: 4, method: 'DOM.setFileInputFiles', params: { files: ['/etc/passwd'] } },
      { id: 5, method: 'Target.createTarget', params: { url: 'about:blank' } },
    ]);
    const byId = new Map(answers.map((a) => [(a as { id: number }).id, a]));
    expect(byId.get(1)).toEqual({ id: 1, result: { did: 'Page.navigate' } });
    expect(byId.get(2)).toMatchObject({ id: 2, sessionId: 's1', error: { code: -32000 } });
    expect(byId.get(3)).toMatchObject({ id: 3, error: { code: -32000 } });
    expect(byId.get(4)).toMatchObject({ id: 4, error: { code: -32000 } });
    expect(byId.get(5)).toEqual({ id: 5, result: { did: 'Target.createTarget' } });
    // Only the allowed ones reached Chromium.
    expect(heard.filter((h) => h.startsWith('{')).map((h) => (JSON.parse(h) as { id: number }).id)).toEqual([
      1, 5,
    ]);
  });

  it('ends Chromium and its connections when it closes', async () => {
    const { browser, origin } = await setUp(null);
    await fetch(`http://${origin}/json/version`);
    await browser.close();
    await expect(fetch(`http://${origin}/json/version`)).rejects.toThrow();
  });
});

describe('which turns get a browser (HE-S137, HE-S139, HE-S140)', () => {
  const ctx = (trigger: string, browser: unknown) =>
    ({ dispatch: { trigger }, browser }) as unknown as DispatchContext;
  const host = { chromium: true };

  it('a turn whose agent may browse', () => {
    expect(browserOf(ctx('mention', null))).toBeNull();
    expect(turnBrowserPlan(ctx('mention', { state: 'available', reason: null, logins: [] }), host)).toEqual({
      sites: null,
    });
    // No Chromium where the commands run: unavailable, and said so.
    expect(turnBrowserPlan(ctx('mention', { logins: [] }), { chromium: false })).toBe('unavailable');
  });

  it('an assessment only with the reported website’s sites, never an open one', () => {
    expect(browserOf(ctx('feedback', { logins: [] }))).toBeNull();
    expect(browserOf(ctx('feedback', { sites: ['example.com'] }))).toEqual({ sites: ['example.com'] });
  });

  it('finds a Chromium in the commands’ tools or the host’s system', () => {
    expect(hasChromium(['/nix/store/x-tools/bin'], (p) => p === '/nix/store/x-tools/bin/chromium')).toBe(
      true,
    );
    expect(hasChromium(['/usr/bin'], (p) => p === '/home/someone/chrome')).toBe(false);
  });
});

describe('the relay’s parts', () => {
  it('reads Chromium’s DevTools line', () => {
    expect(devtoolsPort('DevTools listening on ws://127.0.0.1:40261/devtools/browser/0a90f58c-dae9')).toBe(
      40261,
    );
    expect(devtoolsPort('[2:35:ERROR:dbus/bus.cc:405] Failed to connect to the bus')).toBeNull();
  });

  it('passes DevTools’ HTTP and WebSockets only, and no /json/new in an assessment', () => {
    const head = (s: string) => parseHead(Buffer.from(`${s}\r\nHost: x\r\n\r\n`));
    const ws = parseHead(Buffer.from('GET /devtools/page/AB12 HTTP/1.1\r\nUpgrade: websocket\r\n\r\n'));
    expect(ws).toMatchObject({ upgrade: true, path: '/devtools/page/AB12' });
    for (const [line, sites, ok] of [
      ['GET /json/version HTTP/1.1', null, true],
      ['GET /json/list HTTP/1.1', null, true],
      ['PUT /json/new?about:blank HTTP/1.1', null, true],
      ['PUT /json/new?about:blank HTTP/1.1', ['example.com'], false],
      ['GET /devtools/inspector.html HTTP/1.1', null, false],
      ['POST /json/version HTTP/1.1', null, false],
    ] as const) {
      const h = head(line);
      expect(h === 'bad' || h === 'more' ? false : passes(h, sites), line).toBe(ok);
    }
    expect(parseHead(Buffer.from('GET /json HTTP/1.1\r\nHost'))).toBe('more');
    expect(parseHead(Buffer.from('nonsense\r\n\r\n'))).toBe('bad');
  });

  it('closes plain requests after their answer', () => {
    const out = closingHead(
      Buffer.from('GET /json HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n'),
    ).toString();
    expect(out).toBe('GET /json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  });

  it('decides an assessment’s addresses by site', () => {
    const sites = ['example.com'];
    expect(siteAllows('https://example.com/a', sites)).toBe(true);
    expect(siteAllows('http://shop.example.com', sites)).toBe(true);
    expect(siteAllows('https://notexample.com', sites)).toBe(false);
    expect(siteAllows('https://example.com.evil.test', sites)).toBe(false);
    expect(siteAllows('file:///etc/passwd', sites)).toBe(false);
    expect(siteAllows('chrome://settings', sites)).toBe(false);
    expect(siteAllows('about:blank', sites)).toBe(true);
    expect(refusedCommand({ method: 'Runtime.evaluate', params: { expression: '1' } }, sites)).toBeNull();
  });

  it('reads masked client frames, fragments included, and answers a refused message', () => {
    const passed: Buffer[] = [];
    const answered: Buffer[] = [];
    const frames = new ClientFrames(
      (text) => (text?.includes('no') ? '{"error":1}' : null),
      (raw) => passed.push(raw),
      (raw) => answered.push(raw),
      () => {
        throw new Error('failed');
      },
    );
    const masked = (opcode: number, fin: boolean, text: string) => {
      const body = Buffer.from(text);
      const mask = Buffer.from([1, 2, 3, 4]);
      const out = Buffer.alloc(body.length);
      for (let i = 0; i < body.length; i++) out[i] = (body[i] as number) ^ (mask[i % 4] as number);
      return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | body.length]), mask, out]);
    };
    const ok = Buffer.concat([masked(0x1, false, '{"a":'), masked(0x9, true, ''), masked(0x0, true, '1}')]);
    // Byte by byte, as a slow connection delivers it.
    for (const b of ok) frames.push(Buffer.from([b]));
    expect(passed.length).toBe(3);
    frames.push(masked(0x1, true, '"no"'));
    expect(passed.length).toBe(3);
    expect(answered[0]?.subarray(2).toString()).toBe('{"error":1}');
  });

  it('reads split extended headers and large bodies, retaining exactly the original frames', () => {
    const seen: (string | null)[] = [];
    const passed: Buffer[] = [];
    const frames = new ClientFrames(
      (text) => {
        seen.push(text);
        return null;
      },
      (raw) => passed.push(raw),
      () => {
        throw new Error('unexpected answer');
      },
      (why) => {
        throw new Error(why);
      },
    );
    for (const length of [0, 125, 126, 65535, 65536, 262144]) {
      const text = `${'€'.repeat(Math.floor(length / 3))}${'x'.repeat(length % 3)}`;
      const raw = maskedFrame(1, true, Buffer.from(text));
      const original = Buffer.from(raw);
      // Every header boundary, then socket-sized pieces of the payload.
      for (let i = 0; i < Math.min(14, raw.length); i++) frames.push(raw.subarray(i, i + 1));
      for (let i = 14; i < raw.length; i += 1024) frames.push(raw.subarray(i, i + 1024));
      expect(seen.at(-1)).toBe(text);
      expect(passed.at(-1)?.equals(original)).toBe(true);
      expect(raw.equals(original)).toBe(true);
      raw.fill(0);
      expect(passed.at(-1)?.equals(original)).toBe(true);
    }
    const binary = maskedFrame(2, true, Buffer.from([255, 0, 128]));
    frames.push(binary);
    expect(seen.at(-1)).toBeNull();
    expect(passed.at(-1)?.equals(binary)).toBe(true);
  });

  it('still refuses unmasked and oversized client frames before forwarding any bytes', () => {
    for (const header of [Buffer.from([0x81, 0]), Buffer.alloc(10)]) {
      if (header.length === 10) {
        header[0] = 0x81;
        header[1] = 0xff;
        header.writeBigUInt64BE(BigInt(32 * 1024 * 1024 + 1), 2);
      }
      const failed: string[] = [];
      const frames = new ClientFrames(
        () => null,
        () => {
          throw new Error('forwarded a refused frame');
        },
        () => {},
        (why) => failed.push(why),
      );
      for (const byte of header) frames.push(Buffer.from([byte]));
      expect(failed).toHaveLength(1);
    }
  });

  it('starts Chromium with a fresh profile, the commands’ proxy, and an assessment’s sites only', () => {
    const open = chromiumCommand(null);
    expect(open).toContain('--remote-debugging-port=0');
    expect(open).toContain('--proxy-server="$proxy"');
    const assessed = chromiumCommand(['example.com']);
    expect(assessed).toContain('--proxy-pac-url=');
    expect(assessed).toContain('"example.com"');
  });

  it('gives each start a fresh profile, and removes the profile of one that was killed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-profile-'));
    const bin = join(root, 'bin');
    const tmp = join(root, 'tmp');
    mkdirSync(bin);
    mkdirSync(tmp);
    // A Chromium that says which profile it got, and runs until it is killed.
    writeFileSync(
      join(bin, 'chromium'),
      '#!/bin/bash\nfor a in "$@"; do case "$a" in --user-data-dir=*) echo "profile $a";; esac; done\nexec sleep 30\n',
      { mode: 0o755 },
    );
    // The commands' `/tmp` is the test's own.
    const script = chromiumCommand(null).replaceAll('/tmp/', `${tmp}/`);
    const started: ReturnType<typeof spawn>[] = [];
    const start = async () => {
      const child = spawn('bash', ['-c', script], {
        detached: true,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      started.push(child);
      let out = '';
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        out += chunk.toString();
        const m = /profile --user-data-dir=(\S+)\n/.exec(out);
        if (m) return { child, profile: m[1] as string };
      }
      throw new Error('it never said its profile');
    };
    try {
      const first = await start();
      writeFileSync(join(first.profile, 'Cookies'), 'secret');
      // Ended as the watchdog ends it (its whole cgroup, SIGKILL): its own cleanup never runs.
      const exited = once(first.child, 'exit');
      process.kill(-(first.child.pid as number), 'SIGKILL');
      await exited;
      expect(existsSync(first.profile)).toBe(true);
      const second = await start();
      expect(second.profile).not.toBe(first.profile);
      expect(existsSync(first.profile)).toBe(false);
      expect(readdirSync(second.profile)).toEqual(['.whombat-pid']);
      // One whose shell still runs keeps its profile.
      await start();
      expect(existsSync(second.profile)).toBe(true);
    } finally {
      for (const c of started) {
        try {
          process.kill(-(c.pid as number), 'SIGKILL');
        } catch {}
      }
    }
  });

  it('runs the start command’s shell as bash reads it', () => {
    // The script itself parses (no Chromium is started: `bash -n`).
    for (const sites of [null, ['example.com']]) {
      const r = spawnSyncBash(['-n', '-c', chromiumCommand(sites)]);
      expect(r, String(sites)).toBe(0);
    }
  });
});

function spawnSyncBash(args: string[]): number | null {
  return spawnSync('bash', args).status;
}

function maskedFrame(opcode: number, fin: boolean, payload: Buffer): Buffer {
  const length = payload.length;
  const header = Buffer.alloc(length < 126 ? 2 : length < 65536 ? 4 : 10);
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = 0x80 | (length < 126 ? length : length < 65536 ? 126 : 127);
  if (header.length === 4) header.writeUInt16BE(length, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(length), 2);
  const mask = Buffer.from([1, 2, 3, 4]);
  const body = Buffer.alloc(length);
  for (let i = 0; i < length; i++) body[i] = (payload[i] as number) ^ (mask[i % 4] as number);
  return Buffer.concat([header, mask, body]);
}
