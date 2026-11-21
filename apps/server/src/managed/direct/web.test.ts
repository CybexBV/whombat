/**
 * The direct listener's page files: a download the browser abandons closes its file at once, as a finished one does.
 */

import { once } from 'node:events';
import type * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, type ReadStream, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { directWeb } from './web';

/** Every file stream the page opens, to see it closed. */
const opened = vi.hoisted(() => [] as ReadStream[]);
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  return {
    ...real,
    createReadStream: (...args: Parameters<typeof real.createReadStream>) => {
      const stream = real.createReadStream(...args);
      opened.push(stream);
      return stream;
    },
  };
});

const root = mkdtempSync(join(tmpdir(), 'wb-direct-files-'));
mkdirSync(join(root, 'assets'));
writeFileSync(join(root, 'index.html'), '<!doctype html><title>Whombat</title>');
// Larger than what the socket and the stream buffer, so the download is still going when the browser leaves.
writeFileSync(join(root, 'assets', 'big-1a2b.js'), Buffer.alloc(8 * 1024 * 1024, 97));
const web = directWeb(root);

/** Resolves when the stream closed, however it ended (an abandoned one ends with an error first). */
const closed = (stream: ReadStream) =>
  stream.closed ? Promise.resolve() : new Promise<void>((resolve) => stream.once('close', () => resolve()));
let server: Server;
let port = 0;

beforeAll(async () => {
  if (!web) throw new Error('no web build');
  server = createServer((req, res) => web.serve(req, res, new URL(req.url ?? '/', 'http://box').pathname));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  server.close();
  rmSync(root, { recursive: true, force: true });
});

describe('a page file on the direct listener', () => {
  it('closes the file when the browser leaves halfway, and after a whole download', async () => {
    const leave = request({ host: '127.0.0.1', port, path: '/assets/big-1a2b.js', agent: false });
    leave.on('error', () => {});
    leave.end();
    const [res] = await once(leave, 'response');
    await once(res, 'data');
    const stream = opened.at(-1);
    if (!stream) throw new Error('no file opened');
    expect(stream.destroyed).toBe(false);
    leave.destroy();
    await closed(stream);
    expect(stream.destroyed).toBe(true);

    const whole = request({ host: '127.0.0.1', port, path: '/assets/big-1a2b.js', agent: false });
    whole.end();
    const [full] = await once(whole, 'response');
    let bytes = 0;
    full.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    await once(full, 'end');
    expect(bytes).toBe(8 * 1024 * 1024);
    const second = opened.at(-1);
    if (!second || second === stream) throw new Error('no second file opened');
    await closed(second);
    expect(second.closed).toBe(true);
  });
});
