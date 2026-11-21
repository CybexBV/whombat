/**
 * The runner's side of a person's pod socket (hermes-native.md HN-W01, HN-W02; `pod-init.mjs`): one JSON line per
 * request. `podRequest` asks for the pod's state or its stop; `podAcpProcess` takes the pod's spare `hermes acp` for a
 * turn, as a process the ACP connection drives like one it spawned (`AcpProcessOptions.spawn`): its stdin and stdout
 * are the connection, closing its stdin closes the connection (which ends that `hermes acp` in the pod), and the
 * connection closing is its exit.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';

/** The pod's state (`{"op":"status"}`). */
export interface PodStatus {
  ok: boolean;
  gateway: { up: boolean; starts: number; gaveUp: boolean } | null;
  spares: number;
  viewers: number;
  error?: string;
}

const LINE_MAX = 64 * 1024;

/** Reads one line from `socket`; `rest` gets whatever came after it. */
function firstLine(socket: Socket, ms: number): Promise<{ line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('the pod didn’t answer in time')), ms);
    timer.unref?.();
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl >= 0) done(null, { line: buf.subarray(0, nl).toString('utf8'), rest: buf.subarray(nl + 1) });
      else if (buf.length > LINE_MAX) done(new Error('the pod’s answer was too long'));
    };
    const onClose = () => done(new Error('the pod closed the connection'));
    const onError = (err: Error) => done(err);
    function done(err: Error | null, value?: { line: string; rest: Buffer }) {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
      if (err) reject(err);
      else resolve(value as { line: string; rest: Buffer });
    }
    socket.on('data', onData);
    socket.on('close', onClose);
    socket.on('error', onError);
  });
}

/** One request to the pod (`status`, `stop`) and its answer. */
export async function podRequest(
  socketPath: string,
  op: 'status' | 'stop',
  timeoutMs = 10_000,
): Promise<PodStatus> {
  const socket = connect(socketPath);
  socket.on('error', () => {});
  try {
    socket.write(`${JSON.stringify({ op })}\n`);
    const { line } = await firstLine(socket, timeoutMs);
    return JSON.parse(line) as PodStatus;
  } finally {
    socket.destroy();
  }
}

/**
 * The pod's `hermes acp` for a turn whose working directory is `cwd`, as a process (see the file comment). Synchronous
 * like a spawn: what is written before the pod answers waits; a refusal or a connection that fails ends it with the
 * reason on its stderr.
 */
export function podAcpProcess(
  socketPath: string,
  cwd: string,
  options: { timeoutMs?: number; onPid?: (pid: number | null) => void } = {},
): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const fields = child as unknown as Record<string, unknown>;
  Object.assign(child, { stdin, stdout, stderr, stdio: [stdin, stdout, stderr], pid: undefined });
  fields.exitCode = null;
  fields.signalCode = null;
  fields.killed = false;
  let exited = false;
  const exit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    fields.exitCode = code;
    fields.signalCode = signal;
    if (!stdout.writableEnded) stdout.end();
    if (!stderr.writableEnded) stderr.end();
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  const socket = connect(socketPath);
  socket.on('error', () => {});
  // The turn let go of its viewer (`AcpProcess.close` destroys stdin): the connection goes, so does the viewer.
  stdin.on('close', () => socket.destroy());
  stdin.on('finish', () => socket.end());
  fields.kill = (signal?: NodeJS.Signals) => {
    fields.killed = true;
    socket.destroy();
    exit(null, signal ?? 'SIGTERM');
    return true;
  };
  stdin.pause();
  socket.once('connect', () => socket.write(`${JSON.stringify({ op: 'acp', cwd })}\n`));
  firstLine(socket, options.timeoutMs ?? 30_000).then(
    ({ line, rest }) => {
      let answer: { ok?: boolean; pid?: number | null; error?: string };
      try {
        answer = JSON.parse(line);
      } catch {
        answer = { ok: false, error: 'the pod’s answer couldn’t be read' };
      }
      if (!answer.ok) {
        stderr.write(`${answer.error ?? 'the pod refused the turn'}\n`);
        socket.destroy();
        exit(1, null);
        return;
      }
      options.onPid?.(answer.pid ?? null);
      if (rest.length) stdout.write(rest);
      socket.pipe(stdout);
      stdin.pipe(socket);
      stdin.resume();
      socket.once('close', () => exit(0, null));
    },
    (err: Error) => {
      stderr.write(`${err.message}\n`);
      socket.destroy();
      // Asynchronous, as a spawn's failure is: listeners are attached by then.
      setImmediate(() => exit(1, null));
    },
  );
  return child;
}
