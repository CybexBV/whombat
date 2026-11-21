/**
 * One ACP agent process and its connection (bp-acp.md BP-E08) for
 * Hermes (`HermesProvider`): the process in its own group (or the managed sandbox's `spawn`), stdio as a strict
 * newline-delimited JSON-RPC stream, Whombat as the client answering only permission requests and session updates
 * (no fs, no terminal: anything else is “method not found”), how the process ended, and a `close` that kills the
 * whole group.
 */
import {
  type ClientConnection,
  client,
  type InitializeRequest,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import type { ProcessSpawner } from '../contract';
import { trimMessage } from '../support/errors';
import { killProcessTree, spawnGroup } from '../support/process-group';
import { ACP_PROTOCOL_VERSION } from './capabilities';
import { boundedNdJsonStream } from './stream';

export const ACP_CLIENT_INFO = { name: 'whombat', title: 'Whombat', version: '0.0.0' };

/** How a turn ended early, from the agent's side. */
export interface AcpEnded {
  reason: string;
  /** Broke the protocol: not retried. */
  violation: boolean;
  /** Could not start at all (spawn error code). */
  code?: string;
}

export interface AcpProcess {
  connection: ClientConnection;
  /** The process Whombat started (the sandbox's outermost wrapper when managed): the leader of everything it starts. */
  pid: number | undefined;
  ended: Promise<AcpEnded>;
  /** How it ended, once it has. */
  endedNow(): AcpEnded | null;
  /** The last lines it wrote on stderr (each at most 300 characters). */
  stderr: string[];
  /** Kills the whole process group (once); later calls wait for the same. */
  close(): Promise<void>;
}

export interface AcpProcessOptions {
  /** What people call it in messages (“Hermes”, the runtime's label). */
  label: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Managed: start it inside the task's sandbox (MSB-01). Default: a process group on the host. */
  spawn?: ProcessSpawner;
  /** SIGTERM → SIGKILL grace for the process group (default 2000 ms). */
  killGraceMs?: number;
  /** Longest line accepted (default `ACP_MAX_LINE_BYTES`). */
  maxLineBytes?: number;
  /** How many stderr lines are kept (default 20). */
  stderrLines?: number;
  onUpdate: (n: SessionNotification) => void;
  onPermission: (
    r: RequestPermissionRequest,
  ) => RequestPermissionResponse | Promise<RequestPermissionResponse>;
  /** Every well-formed message from the agent (idle timers). */
  onActivity?: () => void;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} didn’t answer within ${Math.round(ms / 1000)} s.`)),
      ms,
    );
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Rejects with the reason the agent ended, so a request races the process. */
export const endedAsError = (ended: Promise<AcpEnded>) =>
  ended.then((e): never => {
    throw Object.assign(new Error(e.reason), { ended: e });
  });

export function openAcpProcess(options: AcpProcessOptions): AcpProcess {
  const { label } = options;
  const child = (options.spawn ?? spawnGroup)(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
  });
  const keep = options.stderrLines ?? 20;
  const stderr: string[] = [];
  child.stderr.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      const text = line.trim();
      if (!text) continue;
      stderr.push(text.slice(0, 300));
      if (stderr.length > keep) stderr.shift();
    }
  });
  let resolveEnded!: (e: AcpEnded) => void;
  const ended = new Promise<AcpEnded>((resolve) => {
    resolveEnded = resolve;
  });
  let settled: AcpEnded | null = null;
  const end = (e: AcpEnded) => {
    if (settled) return;
    settled = e;
    resolveEnded(e);
  };
  const tail = () => {
    const t = stderr.slice(-3).join(' ');
    return t ? `: ${t}` : '';
  };
  child.on('error', (err: NodeJS.ErrnoException) =>
    end({
      reason: `${label} couldn’t start (${err.code ?? err.message})`,
      violation: false,
      ...(err.code ? { code: err.code } : {}),
    }),
  );
  child.on('exit', (code, signal) => {
    // Let what it wrote last (the prompt's answer) arrive before calling it gone.
    const report = () =>
      end({
        reason: trimMessage(`${label} exited unexpectedly (${String(code ?? signal)})${tail()}`),
        violation: false,
      });
    if (child.stdout.readableEnded) report();
    else {
      const timer = setTimeout(report, 500);
      timer.unref?.();
      child.stdout.once('end', () => {
        clearTimeout(timer);
        setImmediate(report);
      });
    }
  });
  const stream = boundedNdJsonStream(child.stdout, child.stdin, {
    ...(options.maxLineBytes ? { maxLineBytes: options.maxLineBytes } : {}),
    ...(options.onActivity ? { onMessage: options.onActivity } : {}),
    onViolation: (reason) => end({ reason: `${label}: ${reason}`, violation: true }),
  });
  // Only permission requests and session updates are Whombat's to answer: no fs, no terminal. Anything
  // else the agent asks is answered “method not found” (-32601) by the library.
  const app = client({ name: 'whombat' })
    .onRequest('session/request_permission', ({ params }) => options.onPermission(params))
    .onNotification('session/update', ({ params }) => options.onUpdate(params));
  const connection = app.connect(stream);
  let closing: Promise<void> | null = null;
  return {
    connection,
    pid: child.pid,
    ended,
    endedNow: () => settled,
    stderr,
    close: () => {
      closing ??= (async () => {
        end({ reason: `${label} was stopped`, violation: false });
        // Kill first: it takes its snapshot of the process tree now, while the agent is still the parent
        // of what it started (closing its stdin first lets it exit and orphan a setsid'd descendant).
        const killing = killProcessTree(child, { graceMs: options.killGraceMs ?? 2000 });
        try {
          connection.close();
        } catch {
          // already closed
        }
        child.stdin.destroy();
        await killing;
      })();
      return closing;
    },
  };
}

/** `initialize` without fs or terminal, racing the process; rejects after `ms`. */
export async function initializeAcp(
  opened: AcpProcess,
  label: string,
  ms: number,
): Promise<InitializeResponse> {
  const params: InitializeRequest = {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: ACP_CLIENT_INFO,
  };
  const answer: Promise<InitializeResponse> = opened.connection.agent.request('initialize', params);
  return withTimeout(Promise.race([answer, endedAsError(opened.ended)]), ms, `${label}’s initialize`);
}
