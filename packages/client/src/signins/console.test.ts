import type { ProviderConsole } from '@whombat/core/domain';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '../http/errors';
import { OutcomeRedactedError } from '../session/types';
import {
  type ConsoleApi,
  type ConsoleDriverState,
  type ConsoleOutput,
  createConsoleDriver,
  decodeBase64,
  takeUtf8,
} from './console';
import { appErrorOf, isRetryable } from './errors';

const b64 = (s: string) => btoa(s);

function consoleOf(over: Partial<ProviderConsole> = {}): ProviderConsole {
  return {
    consoleId: 'pcn_test0001',
    provider: 'claude',
    authMode: 'subscription_cli',
    state: 'running',
    exitCode: null,
    cols: 80,
    rows: 24,
    startedAt: '2026-09-26T10:00:00Z',
    expiresAt: '2026-09-26T10:10:00Z',
    endedAt: null,
    outputBytes: 0,
    inputSeq: 0,
    error: null,
    ...over,
  };
}

/** A console API whose reads are answered by the test, one at a time. */
function fakeApi() {
  const reads: {
    cursor: number;
    resolve: (o: ConsoleOutput) => void;
    reject: (e: unknown) => void;
    signal: AbortSignal;
  }[] = [];
  const writes: { seq: number; data: string }[] = [];
  const writeFailures: unknown[] = [];
  const resizes: [number, number][] = [];
  const cancels: string[] = [];
  let started: { cols: number; rows: number } | null = null;
  const api: ConsoleApi = {
    start: vi.fn(async (size) => {
      started = size;
      return consoleOf({ cols: size.cols, rows: size.rows });
    }),
    read: (_id, cursor, _wait, signal) =>
      new Promise<ConsoleOutput>((resolve, reject) => reads.push({ cursor, resolve, reject, signal })),
    write: vi.fn(async (_id, seq, data) => {
      writes.push({ seq, data });
      const failure = writeFailures.shift();
      if (failure) throw failure;
      return consoleOf({ inputSeq: seq });
    }),
    resize: vi.fn(async (_id, cols, rows) => {
      resizes.push([cols, rows]);
      return consoleOf({ cols, rows });
    }),
    cancel: vi.fn(async (id) => {
      cancels.push(id);
      return consoleOf({ state: 'cancelled' });
    }),
  };
  return {
    api,
    reads,
    writes,
    writeFailures,
    resizes,
    cancels,
    get started() {
      return started;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await tick();
  expect(check()).toBe(true);
};
const noSleep = async () => {};

describe('the sign-in console loop (CT-71)', () => {
  it('starts, reads from the cursor it was given, writes the output bytes and stops once ended', async () => {
    const f = fakeApi();
    const out: string[] = [];
    const states: ConsoleDriverState[] = [];
    createConsoleDriver({
      api: f.api,
      cols: 100,
      rows: 30,
      onOutput: (b) => out.push(new TextDecoder().decode(b)),
      onState: (s) => states.push(s),
      sleep: noSleep,
    });
    await until(() => f.reads.length === 1);
    expect(f.started).toEqual({ cols: 100, rows: 30 });
    expect(f.reads[0]?.cursor).toBe(0);
    f.reads[0]?.resolve({
      console: consoleOf(),
      from: 0,
      data: b64('Open https://claude.ai/x\r\n'),
      next: 26,
      more: false,
    });
    await until(() => f.reads.length === 2);
    expect(f.reads[1]?.cursor).toBe(26);
    // Output the server no longer keeps: it answers from a later `from`, and the cursor follows `next`.
    f.reads[1]?.resolve({
      console: consoleOf(),
      from: 40,
      data: b64('Paste code here > '),
      next: 58,
      more: true,
    });
    await until(() => f.reads.length === 3);
    expect(f.reads[2]?.cursor).toBe(58);
    f.reads[2]?.resolve({
      console: consoleOf({ state: 'completed', exitCode: 0 }),
      from: 58,
      data: b64('Login successful\r\n'),
      next: 76,
      more: false,
    });
    await until(() => states.at(-1)?.phase === 'completed');
    await tick();
    expect(f.reads).toHaveLength(3);
    expect(out.join('')).toBe('Open https://claude.ai/x\r\nPaste code here > Login successful\r\n');
    expect(states.map((s) => s.phase)).toContain('running');
  });

  it('numbers writes from the console’s inputSeq and resends the same seq after a lost answer', async () => {
    const f = fakeApi();
    const driver = createConsoleDriver({
      api: f.api,
      resume: consoleOf({ inputSeq: 4 }),
      cols: 80,
      rows: 24,
      onOutput: () => {},
      onState: () => {},
      sleep: noSleep,
    });
    await until(() => f.reads.length === 1);
    expect(f.api.start).not.toHaveBeenCalled();
    f.writeFailures.push(new NetworkError('signins.consoleWrite', new Error('offline')));
    driver.input('abc123');
    await until(() => f.writes.length === 2);
    expect(f.writes).toEqual([
      { seq: 5, data: 'abc123' },
      { seq: 5, data: 'abc123' },
    ]);
    driver.input('\r');
    await until(() => f.writes.length === 3);
    expect(f.writes[2]).toEqual({ seq: 6, data: '\r' });
  });

  it('counts a redacted outcome that went through as applied, and retries one that is unknown', async () => {
    const f = fakeApi();
    const driver = createConsoleDriver({
      api: f.api,
      cols: 80,
      rows: 24,
      onOutput: () => {},
      onState: () => {},
      sleep: noSleep,
    });
    await until(() => f.reads.length === 1);
    f.writeFailures.push(new OutcomeRedactedError('signins.consoleWrite', 'r1', 'completed'));
    driver.input('a');
    await until(() => f.writes.length === 1);
    f.writeFailures.push(new OutcomeRedactedError('signins.consoleWrite', 'r2', null));
    driver.input('b');
    await until(() => f.writes.length === 3);
    expect(f.writes.map((w) => w.seq)).toEqual([1, 2, 2]);
  });

  it('renumbers after a refused gap from the inputSeq the server reports', async () => {
    const f = fakeApi();
    const driver = createConsoleDriver({
      api: f.api,
      cols: 80,
      rows: 24,
      onOutput: () => {},
      onState: () => {},
      sleep: noSleep,
    });
    await until(() => f.reads.length === 1);
    // Over the session the app code is the error's code; the details carry the last applied seq.
    f.writeFailures.push(
      new ApiError(
        409,
        'unknown',
        'Request failed',
        {
          error: {
            code: 'provider.console_input_gap',
            message: 'gap',
            details: { code: 'provider.console_input_gap', inputSeq: 7 },
          },
        },
        'signins.consoleWrite',
      ),
    );
    driver.input('x');
    await until(() => f.writes.length === 2);
    expect(f.writes.map((w) => w.seq)).toEqual([1, 8]);
  });

  it('splits a large paste into writes of at most 4 KiB of UTF-8', async () => {
    const f = fakeApi();
    const driver = createConsoleDriver({
      api: f.api,
      cols: 80,
      rows: 24,
      onOutput: () => {},
      onState: () => {},
      sleep: noSleep,
    });
    await until(() => f.reads.length === 1);
    driver.input('é'.repeat(3000)); // 6000 bytes
    await until(() => f.writes.length === 2);
    expect(f.writes.map((w) => w.data.length)).toEqual([2048, 952]);
    expect(f.writes.map((w) => w.seq)).toEqual([1, 2]);
  });

  it('sends a changed size, clamped to the contract, and nothing for the same size', async () => {
    const f = fakeApi();
    const driver = createConsoleDriver({
      api: f.api,
      cols: 80,
      rows: 24,
      onOutput: () => {},
      onState: () => {},
      sleep: noSleep,
    });
    await until(() => f.reads.length === 1);
    driver.resize(80, 24);
    driver.resize(900, 2);
    await until(() => f.resizes.length === 1);
    expect(f.resizes).toEqual([[400, 5]]);
  });

  it('retries a failed read with the same cursor, and says failed when the console is gone', async () => {
    const f = fakeApi();
    const states: ConsoleDriverState[] = [];
    createConsoleDriver({
      api: f.api,
      cols: 80,
      rows: 24,
      onOutput: () => {},
      onState: (s) => states.push(s),
      sleep: noSleep,
    });
    await until(() => f.reads.length === 1);
    f.reads[0]?.resolve({ console: consoleOf(), from: 0, data: b64('hi'), next: 2, more: false });
    await until(() => f.reads.length === 2);
    f.reads[1]?.reject(new NetworkError('signins.consoleRead', new Error('offline')));
    await until(() => f.reads.length === 3);
    expect(f.reads[2]?.cursor).toBe(2);
    f.reads[2]?.reject(
      new ApiError(
        404,
        'not_found',
        'No such sign-in console.',
        {
          error: {
            code: 'not_found',
            message: 'No such sign-in console.',
            details: { code: 'provider.console_not_found' },
          },
        },
        'signins.consoleRead',
      ),
    );
    await until(() => states.at(-1)?.phase === 'failed');
    expect(states.at(-1)?.error?.code).toBe('provider.console_not_found');
  });

  it('cancels a running console on close and stops reading', async () => {
    const f = fakeApi();
    const driver = createConsoleDriver({
      api: f.api,
      cols: 80,
      rows: 24,
      onOutput: () => {},
      onState: () => {},
      sleep: noSleep,
    });
    await until(() => f.reads.length === 1);
    await driver.close();
    expect(f.cancels).toEqual(['pcn_test0001']);
    expect(f.reads[0]?.signal.aborted).toBe(true);
    driver.input('late');
    await tick();
    expect(f.writes).toEqual([]);
  });

  it('reports a refused start with the server’s reason', async () => {
    const f = fakeApi();
    (f.api.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(
        403,
        'forbidden',
        'Claude sign-in isn’t available here.',
        { error: { code: 'forbidden', message: 'Claude sign-in isn’t available here.' } },
        'signins.consoleStart',
      ),
    );
    const states: ConsoleDriverState[] = [];
    createConsoleDriver({
      api: f.api,
      cols: 80,
      rows: 24,
      onOutput: () => {},
      onState: (s) => states.push(s),
      sleep: noSleep,
    });
    await until(() => states.at(-1)?.phase === 'failed');
    expect(states.at(-1)?.error).toEqual({
      code: 'forbidden',
      message: 'Claude sign-in isn’t available here.',
    });
  });
});

describe('console helpers', () => {
  it('decodes base64 without atob, across multi-byte characters', () => {
    const text = 'Paste code › ✓ done';
    const bytes = new TextEncoder().encode(text);
    const b64text = btoa(String.fromCharCode(...bytes));
    expect(new TextDecoder().decode(decodeBase64(b64text))).toBe(text);
    expect(decodeBase64('')).toEqual(new Uint8Array());
  });

  it('never splits a surrogate pair', () => {
    const [a, b] = takeUtf8('ab😀cd', 4);
    expect(a).toBe('ab');
    expect(b).toBe('😀cd');
    expect(takeUtf8('😀', 1)).toEqual(['😀', '']);
  });

  it('reads the application code on both transports', () => {
    const rest = new ApiError(
      409,
      'conflict',
      'x',
      { error: { code: 'conflict', message: 'Busy.', details: { code: 'client.busy' } } },
      'clients.install',
    );
    expect(appErrorOf(rest)).toMatchObject({ code: 'client.busy', message: 'Busy.', status: 409 });
    expect(isRetryable(rest)).toBe(false);
    const busy = new ApiError(
      503,
      'unknown',
      'x',
      { error: { code: 'unavailable', message: 'Later.' } },
      'x',
    );
    expect(isRetryable(busy)).toBe(true);
  });
});

describe('where people sign in', () => {
  it('is Settings → AI of the burrow', async () => {
    const { aiAccountsPath } = await import('./model');
    expect(aiAccountsPath('burrow-hq')).toBe('/settings?tab=agent&part=ai&burrow=burrow-hq');
  });
});
