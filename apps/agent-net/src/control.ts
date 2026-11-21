/**
 * The runner's way in (docs/decisions/one-person.md OP-S106): `control.sock`, next to `proxy.sock`, one JSON line in and
 * one out. `policy` replaces what the wall allows (`NetPolicy`: the home networks, the local network, the production
 * servers, the openings of the commands running now); `status` says what it is. The pod gets `proxy.sock` alone, so a
 * command never reaches this socket.
 */
import { chmod, rm } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { z } from 'zod';
import { NetPolicy } from './rules';

const LINE_MAX = 256 * 1024;

export const ControlRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('policy'), policy: NetPolicy }),
  z.object({ op: z.literal('status') }),
]);
export type ControlRequest = z.infer<typeof ControlRequest>;

export type ControlAnswer = { ok: true; policy?: NetPolicy } | { ok: false; error: string };

function firstLine(socket: Socket, ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => done(new Error('no answer in time')), ms);
    timer.unref?.();
    const onData = (c: Buffer) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) done(null, buf.slice(0, nl));
      else if (buf.length > LINE_MAX) done(new Error('a line too long'));
    };
    const onEnd = () => done(new Error('the connection closed'));
    function done(err: Error | null, line?: string) {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onEnd);
      if (err) reject(err);
      else resolve(line as string);
    }
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onEnd);
  });
}

export interface ControlServer {
  close(): Promise<void>;
}

/** Serves the runner on `path` (mode `mode`): `apply` takes a new policy, `current` answers `status`. */
export async function startControl(o: {
  path: string;
  mode?: number;
  apply: (policy: NetPolicy) => void;
  current: () => NetPolicy;
}): Promise<ControlServer> {
  const server: Server = createServer((socket) => {
    socket.on('error', () => {});
    firstLine(socket, 10_000).then(
      (line) => {
        let parsed: ReturnType<typeof ControlRequest.safeParse>;
        try {
          parsed = ControlRequest.safeParse(JSON.parse(line));
        } catch {
          socket.end(`${JSON.stringify({ ok: false, error: 'not JSON' })}\n`);
          return;
        }
        if (!parsed.success) {
          socket.end(`${JSON.stringify({ ok: false, error: 'not a request this daemon knows' })}\n`);
          return;
        }
        if (parsed.data.op === 'policy') o.apply(parsed.data.policy);
        const answer: ControlAnswer =
          parsed.data.op === 'status' ? { ok: true, policy: o.current() } : { ok: true };
        socket.end(`${JSON.stringify(answer)}\n`);
      },
      () => socket.destroy(),
    );
  });
  await rm(o.path, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(o.path, o.mode ?? 0o600);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        void rm(o.path, { force: true }).catch(() => {});
      }),
  };
}

/** The runner's side: one request to `control.sock` and its answer. */
export async function controlRequest(
  path: string,
  request: ControlRequest,
  ms = 5_000,
): Promise<ControlAnswer> {
  const socket = connect(path);
  socket.on('error', () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    socket.write(`${JSON.stringify(request)}\n`);
    return JSON.parse(await firstLine(socket, ms)) as ControlAnswer;
  } finally {
    socket.destroy();
  }
}
