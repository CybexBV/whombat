import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { askLine, socketTarget } from './line-client.mjs';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A unix socket server (at a fresh path unless given one) that does `serve` with each connection's first line. */
async function server(
  serve: (socket: Socket, line: string) => void,
  path = join(mkdtempSync(join(tmpdir(), 'wb-line-')), 's.sock'),
): Promise<string> {
  const s = createServer((socket) => {
    let buf = '';
    socket.on('data', (c) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) serve(socket, buf.slice(0, nl));
    });
    socket.on('error', () => {});
  });
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(path, resolve));
  return path;
}

/** Each failure answers with its own name, so the test sees which one it was. */
const on = {
  refused: (err: NodeJS.ErrnoException) => ({ failed: 'refused', code: err.code }),
  broken: (err: NodeJS.ErrnoException) => ({ failed: 'broken', code: err.code }),
  unreadable: () => ({ failed: 'unreadable' }),
  closed: (connected: boolean) => ({ failed: 'closed', connected }),
  timeout: () => ({ failed: 'timeout' }),
};

describe('one JSON line to the runner', () => {
  it('sends the request as a line and answers with the first line back, in pieces or not', async () => {
    const heard: unknown[] = [];
    const path = await server((socket, line) => {
      heard.push(JSON.parse(line));
      socket.write('{"ok":');
      setImmediate(() => socket.write('true}\n{"later":1}\n'));
    });
    expect(await askLine({ path }, { op: 'status' }, on)).toEqual({ reply: { ok: true } });
    expect(heard).toEqual([{ op: 'status' }]);
  });

  it('tells a socket it couldn’t reach from one that closed or answered nonsense', async () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'wb-line-')), 'none.sock');
    expect(await askLine({ path: missing }, {}, on)).toEqual({ failed: 'refused', code: 'ENOENT' });
    const closing = await server((socket) => socket.end());
    expect(await askLine({ path: closing }, {}, on)).toEqual({ failed: 'closed', connected: true });
    const garbled = await server((socket) => socket.write('not json\n'));
    expect(await askLine({ path: garbled }, {}, on)).toEqual({ failed: 'unreadable' });
  });

  it('gives up on a silent runner after the time it is given, and waits without one', async () => {
    const silent = await server(() => {});
    expect(await askLine({ path: silent }, {}, on, 20)).toEqual({ failed: 'timeout' });
    const slow = await server((socket) => setTimeout(() => socket.write('{}\n'), 50));
    expect(await askLine({ path: slow }, {}, on)).toEqual({ reply: {} });
  });

  it('reaches a socket whose path is longer than a unix socket allows from its folder', async () => {
    let dir = mkdtempSync(join(tmpdir(), 'wb-line-'));
    while (dir.length < 110) dir = join(dir, 'a-rather-long-folder-name');
    mkdirSync(dir, { recursive: true });
    // Listening through a short link to the long folder, the way the runner does.
    const short = mkdtempSync(join(tmpdir(), 'wb-lines-'));
    symlinkSync(dir, join(short, 'd'));
    await server((socket) => socket.write('{"ok":true}\n'), join(short, 'd', 's.sock'));
    const cwd = process.cwd();
    try {
      const target = socketTarget(join(dir, 's.sock'));
      expect(target).toEqual({ path: './s.sock' });
      expect(process.cwd()).toBe(realpathSync(dir));
      expect(await askLine(target, {}, on)).toEqual({ reply: { ok: true } });
    } finally {
      process.chdir(cwd);
    }
    expect(socketTarget('/run/whombat/agent.sock')).toEqual({ path: '/run/whombat/agent.sock' });
  });
});
