import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { ClientFrames, textFrame } from './browser';
import { CdpClient } from './cdp';

it('reads a fragmented CDP response with interleaved control frames over the relay socket', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-cdp-client-'));
  const socketPath = join(dir, 'cdp.sock');
  const server = createServer((_req, res) => {
    res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/test' }));
  });
  let peer: Socket | undefined;
  let client: CdpClient | undefined;
  const pong = completion();
  const emitted = completion();
  const data = '€'.repeat(90_000);
  server.on('upgrade', (_req, socket: Socket) => {
    peer = socket;
    socket.on('error', () => {});
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    const incoming = new ClientFrames(
      (text) => {
        const { id } = JSON.parse(text ?? '{}') as { id: number };
        void (async () => {
          const first = textFrame(`{"id":${id},"result":{"data":"`);
          first[0] = 0x01;
          const ping = Buffer.from([0x89, 1, 42]);
          const last = textFrame(`${data}"}}`);
          last[0] = 0x80;
          const bytes = Buffer.concat([first, ping, last]);
          // A partial initial frame, then several network chunks containing an extended-length continuation.
          for (const byte of bytes.subarray(0, 7)) {
            socket.write(Buffer.from([byte]));
            await setImmediate();
          }
          for (let at = 7; at < bytes.length; at += 1024) {
            socket.write(bytes.subarray(at, at + 1024));
            await setImmediate();
          }
          emitted.resolve();
        })().catch(emitted.reject);
        return null;
      },
      (raw) => {
        if (((raw[0] ?? 0) & 0x0f) === 0xa) pong.resolve();
      },
      () => {},
      (why) => pong.reject(new Error(why)),
    );
    socket.on('data', (bytes: Buffer) => incoming.push(bytes));
  });
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    client = await CdpClient.open(socketPath, 3000);
    expect(await client.send('Page.captureScreenshot')).toEqual({ data });
    await Promise.all([pong.promise, emitted.promise]);
  } finally {
    client?.close();
    peer?.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

function completion() {
  let resolve = () => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<void>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}
