/**
 * Whombat's own processes where the agent's commands run (one-person.md OP-S113): the browser's Chromium is started in
 * a command's wrapper by the sandbox's init (`pod-init.mjs` on `pod.sock`, `commands-init.mjs` on its own socket: the
 * `own` request, never through the guard), and reached through the holder's way in (`in.sock`: one line `<port>`, then
 * `127.0.0.1:<port>` of the commands' network).
 */
import { connect, type Socket } from 'node:net';
import type { BrowserHost } from '../browser';
import type { CommandsPlace } from './place';

const LINE_MAX = 64 * 1024;

/** Starts `argv` in a command's wrapper through the init's socket; resolves with the connection once it runs. */
export function ownProcess(
  socketPath: string,
  spec: { bwrap: readonly string[]; env: Readonly<Record<string, string>> },
  argv: readonly string[],
  timeoutMs = 15_000,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error('the sandbox didn’t start it in time')), timeoutMs);
    timer.unref?.();
    function fail(err: Error) {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    }
    socket.once('error', fail);
    socket.once('connect', () =>
      socket.write(`${JSON.stringify({ op: 'own', bwrap: spec.bwrap, env: spec.env, argv })}\n`),
    );
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > LINE_MAX) fail(new Error('the sandbox’s answer was too long'));
        return;
      }
      socket.off('data', onData);
      socket.pause();
      clearTimeout(timer);
      socket.off('error', fail);
      socket.on('error', () => {});
      let answer: { ok?: boolean; error?: string };
      try {
        answer = JSON.parse(buf.subarray(0, nl).toString('utf8'));
      } catch {
        answer = { ok: false, error: 'the sandbox’s answer couldn’t be read' };
      }
      if (!answer.ok) {
        socket.destroy();
        reject(new Error(answer.error ?? 'the sandbox refused it'));
        return;
      }
      const rest = buf.subarray(nl + 1);
      resolve(socket);
      if (rest.length) setImmediate(() => socket.emit('data', rest));
      setImmediate(() => socket.resume());
    };
    socket.on('data', onData);
  });
}

/** A connection to `127.0.0.1:<port>` of the commands' network, through the holder's way in. */
export function inboundConnection(inbound: string, port: number): Socket {
  const socket = connect(inbound);
  // Written now, so it goes before anything the caller writes (the writes wait for the connection in order).
  socket.write(`${port}\n`);
  return socket;
}

/** The browser's host in a place: its Chromium through `ownSocket`, its connections through the holder. */
export function browserHost(place: CommandsPlace, ownSocket: string): BrowserHost {
  return {
    shell: place.shell,
    start: (argv) => ownProcess(ownSocket, place.ownSpec(), argv),
    connect: (port) => inboundConnection(place.inbound, port),
  };
}
