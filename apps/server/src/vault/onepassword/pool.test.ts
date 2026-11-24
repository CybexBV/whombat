/**
 * The 1Password worker's pool (docs/decisions/onepassword-sync.md) with a stand-in child process: what a worker writes
 * to stderr is logged without the tokens it was sent, and a worker the pool has replaced is not listened to any more
 * (the tokens it was sent are forgotten, so its words couldn't be cleaned of them).
 */
import type { EventEmitter } from 'node:events';
import type { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../services';
import { OnePasswordPool } from './pool';

interface StandInChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
}

const started = vi.hoisted(() => [] as StandInChild[]);

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  return {
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null as string | null,
        kill(signal: string) {
          child.signalCode = signal;
          return true;
        },
        unref() {},
      });
      started.push(child);
      return child;
    },
  };
});

/** One turn of the event loop: what a stream was given has been delivered. */
const delivered = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('the worker’s stderr', () => {
  it('is logged without the token, and not at all once the worker was replaced', async () => {
    const said: string[] = [];
    const log: Logger = {
      info: () => {},
      debug: () => {},
      error: () => {},
      warn: (obj, msg) => said.push(`${msg ?? ''} ${JSON.stringify(obj)}`),
    };
    const pool = new OnePasswordPool({ log, url: new URL('file:///standin-worker.mjs') });
    // A token without a service account token's usual shape: only the pool's own list of tokens can take it out.
    const token = 'plain-token-0123456789abcdefghij';
    const call = pool.check(token).catch((err: unknown) => err);
    const [first] = started;
    if (!first) throw new Error('no worker started');
    first.stderr.write(`trouble with ${token}`);
    await delivered();
    expect(said.some((s) => s.includes('trouble with [hidden]'))).toBe(true);
    first.emit('exit', 3, null);
    await call;
    first.stderr.write(`late words with ${token}`);
    await delivered();
    expect(said.join('\n')).not.toContain(token);
    expect(said.join('\n')).not.toContain('late words');
    pool.close();
  });
});
