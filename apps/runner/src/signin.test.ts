/**
 * The runner's sign-in console relay (CT-71): requests from `signin.poll` reach the executor with the contract's
 * params, and console output and exits go to `signin.console` in order — a failed report is retried with the same
 * events, and consoles the server calls unknown are stopped. A fake `claude` runs in a real PTY.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConsoleSignInEvent } from '@whombat/core/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { CONSOLE_BYTES_PER_POST, CONSOLE_EVENTS_PER_POST, consoleBatch, SignInWorker } from './signin';

const FAKE_CLAUDE = fileURLToPath(
  new URL('../../../packages/agent-runtime/src/providers/testing/fake-claude.mjs', import.meta.url),
);

const workers: SignInWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
});

const out = (consoleId: string, offset: number, text: string): ConsoleSignInEvent => ({
  kind: 'output',
  consoleId,
  offset,
  data: Buffer.from(text).toString('base64'),
});

describe('consoleBatch', () => {
  it('merges adjacent output of one console, keeps order and caps a report at 64 events', () => {
    const exit: ConsoleSignInEvent = {
      kind: 'exit',
      consoleId: 'pcn_aaaaaaaa',
      exitCode: 0,
      state: 'completed',
      error: null,
    };
    const { events, taken } = consoleBatch([
      out('pcn_aaaaaaaa', 0, 'ab'),
      out('pcn_aaaaaaaa', 2, 'cd'),
      out('pcn_bbbbbbbb', 0, 'x'),
      out('pcn_aaaaaaaa', 4, 'ef'),
      exit,
    ]);
    expect(taken).toBe(5);
    expect(events).toEqual([
      out('pcn_aaaaaaaa', 0, 'abcd'),
      out('pcn_bbbbbbbb', 0, 'x'),
      out('pcn_aaaaaaaa', 4, 'ef'),
      exit,
    ]);

    const many = Array.from({ length: 100 }, (_, i) => out(i % 2 ? 'pcn_aaaaaaaa' : 'pcn_bbbbbbbb', i, 'z'));
    const first = consoleBatch(many);
    expect(first.events).toHaveLength(CONSOLE_EVENTS_PER_POST);
    expect(first.taken).toBe(CONSOLE_EVENTS_PER_POST);
    expect(first.events).toEqual(many.slice(0, CONSOLE_EVENTS_PER_POST));

    // Never more than 16 KiB in one output event.
    const big = consoleBatch([
      out('pcn_aaaaaaaa', 0, 'y'.repeat(16_000)),
      out('pcn_aaaaaaaa', 16_000, 'y'.repeat(1_000)),
    ]);
    expect(big.events).toHaveLength(2);
  });

  it('merges tiny binary fragments once per item without crossing a gap or the report byte limit', () => {
    const data = Buffer.from(Array.from({ length: CONSOLE_BYTES_PER_POST + 31 }, (_, i) => i % 256));
    const queue: ConsoleSignInEvent[] = [];
    for (let offset = 0; offset < data.length; offset += 7)
      queue.push({
        kind: 'output',
        consoleId: 'pcn_aaaaaaaa',
        offset,
        data: data.subarray(offset, offset + 7).toString('base64'),
      });
    const { events, taken } = consoleBatch(queue);
    const merged = Buffer.concat(
      events.map((event) => {
        if (event.kind !== 'output') throw new Error('not output');
        ConsoleSignInEvent.parse(event);
        return Buffer.from(event.data, 'base64');
      }),
    );
    expect(merged.length).toBeLessThanOrEqual(CONSOLE_BYTES_PER_POST);
    expect(merged.length + 7).toBeGreaterThan(CONSOLE_BYTES_PER_POST);
    expect(merged.equals(data.subarray(0, merged.length))).toBe(true);
    expect(taken * 7).toBe(merged.length);
    expect(consoleBatch(queue.slice(taken)).events[0]).toMatchObject({ offset: merged.length });

    const gap = [out('pcn_aaaaaaaa', 0, 'a'), out('pcn_aaaaaaaa', 2, 'b'), out('pcn_aaaaaaaa', 3, 'c')];
    expect(consoleBatch(gap)).toEqual({
      taken: 3,
      events: [gap[0], out('pcn_aaaaaaaa', 2, 'bc')],
    });
    expect(gap[1]).toEqual(out('pcn_aaaaaaaa', 2, 'b'));
    expect(
      consoleBatch([
        out('pcn_aaaaaaaa', 0, ''),
        out('pcn_aaaaaaaa', 0, 'a'),
        out('pcn_aaaaaaaa', 1, ''),
        out('pcn_aaaaaaaa', 1, ''),
      ]),
    ).toEqual({ taken: 4, events: [out('pcn_aaaaaaaa', 0, 'a')] });
  });
});

// Real PTYs running a real Node process, several round trips each: on a loaded machine (the harness runs gates in
// parallel) starting one alone can take seconds, so these wait for events, not for the 5 s default (DG-49).
const CONSOLE_TEST_MS = 60_000;
const CONSOLE_WAIT_MS = 45_000;

describe('SignInWorker consoles', { timeout: CONSOLE_TEST_MS }, () => {
  function setup(answer: (events: ConsoleSignInEvent[], attempt: number) => Response) {
    const accepted: ConsoleSignInEvent[] = [];
    const attempts: ConsoleSignInEvent[][] = [];
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path !== '/internal/runner/signin/console') return new Response('{}', { status: 404 });
      const body = JSON.parse(String(init?.body)) as { events: ConsoleSignInEvent[] };
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.events.length).toBeLessThanOrEqual(64);
      for (const e of body.events) ConsoleSignInEvent.parse(e);
      attempts.push(body.events);
      const res = answer(body.events, attempts.length);
      if (res.ok) accepted.push(...body.events);
      return res;
    }) as typeof fetch;
    const logs: string[] = [];
    const worker = new SignInWorker({
      serverUrl: 'http://127.0.0.1:1',
      token: 't',
      root: mkdtempSync(join(tmpdir(), 'wb-runner-console-')),
      fetchImpl,
      commands: { claude: FAKE_CLAUDE },
      hostEnv: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
      consoleRetryMs: 20,
      log: (_level, msg) => logs.push(msg),
    });
    workers.push(worker);
    const text = (id: string) =>
      Buffer.concat(
        accepted
          .filter((e) => e.consoleId === id && e.kind === 'output')
          .map((e) => Buffer.from((e as { data: string }).data, 'base64')),
      ).toString('utf8');
    const until = async (what: () => unknown, ms = CONSOLE_WAIT_MS) => {
      const deadline = Date.now() + ms;
      while (!what()) {
        if (Date.now() > deadline) throw new Error('timed out waiting');
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const exitOf = (id: string) => accepted.find((e) => e.consoleId === id && e.kind === 'exit');
    return { worker, accepted, attempts, logs, text, until, exitOf };
  }

  const start = (consoleId: string) => ({
    id: `req-${consoleId}`,
    method: 'consoleStart' as const,
    params: {
      consoleId,
      provider: 'claude',
      authMode: 'subscription_cli',
      cols: 80,
      rows: 24,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    },
  });

  it('relays start, resize and input, and reports output then the exit in order, retrying a failed report', async () => {
    const s = setup((_events, attempt) =>
      attempt <= 2 ? new Response('no', { status: 503 }) : Response.json({ ok: true, unknown: [] }),
    );
    expect(await s.worker.handle(start('pcn_worker01'))).toEqual({ ok: true });
    await s.until(() => s.text('pcn_worker01').includes('Paste code here'));
    expect(
      await s.worker.handle({
        id: 'r2',
        method: 'consoleResize',
        params: { consoleId: 'pcn_worker01', cols: 120, rows: 40 },
      }),
    ).toEqual({ ok: true });
    // The resize reaches the fake as SIGWINCH, which its event loop may handle after the input sent right behind it
    // (it then prints the size before): ask again until the new size shows (DG-49).
    const sizes = (): string[] => s.text('pcn_worker01').match(/SIZE \d+x\d+/g) ?? [];
    for (let asked = 0; !sizes().includes('SIZE 120x40'); asked++) {
      expect(asked).toBeLessThan(20);
      const before = sizes().length;
      expect(
        await s.worker.handle({
          id: `r3-${asked}`,
          method: 'consoleInput',
          params: { consoleId: 'pcn_worker01', data: 'size\r' },
        }),
      ).toEqual({ ok: true });
      await s.until(() => sizes().length > before);
    }
    await s.worker.handle({
      id: 'r4',
      method: 'consoleInput',
      params: { consoleId: 'pcn_worker01', data: 'good\r' },
    });
    await s.until(() => s.exitOf('pcn_worker01'));

    // The first two reports failed and were sent again from the same start (with any output that arrived
    // meanwhile merged in): nothing dropped, nothing out of order.
    const bytesOf = (e: ConsoleSignInEvent | undefined) =>
      e?.kind === 'output' ? Buffer.from(e.data, 'base64') : Buffer.alloc(0);
    const first = bytesOf(s.attempts[0]?.[0]);
    expect(first.length).toBeGreaterThan(0);
    for (const attempt of s.attempts.slice(1, 3)) {
      expect(attempt[0]).toMatchObject({ kind: 'output', offset: 0 });
      expect(bytesOf(attempt[0]).subarray(0, first.length).equals(first)).toBe(true);
    }
    let next = 0;
    for (const e of s.accepted.slice(0, -1)) {
      expect(e.kind).toBe('output');
      if (e.kind !== 'output') continue;
      expect(e.offset).toBe(next);
      next += Buffer.from(e.data, 'base64').length;
    }
    expect(s.accepted.at(-1)).toEqual({
      kind: 'exit',
      consoleId: 'pcn_worker01',
      exitCode: 0,
      state: 'completed',
      error: null,
    });
    // The failures were logged without their content.
    expect(s.logs.length).toBeGreaterThanOrEqual(2);
    for (const line of s.logs) expect(line).not.toMatch(/claude\.ai|Paste|size|good/);
  });

  it('stops consoles the server no longer knows', async () => {
    const s = setup((events) =>
      Response.json({ ok: true, unknown: [...new Set(events.map((e) => e.consoleId))] }),
    );
    expect(await s.worker.handle(start('pcn_worker02'))).toEqual({ ok: true });
    await s.until(() => s.exitOf('pcn_worker02'));
    expect(s.exitOf('pcn_worker02')).toMatchObject({ state: 'cancelled' });
    expect(
      await s.worker.handle({
        id: 'r5',
        method: 'consoleInput',
        params: { consoleId: 'pcn_worker02', data: 'x' },
      }),
    ).toMatchObject({ ok: false, code: 'provider.console_ended' });
  });

  it('checks params with the contract and answers unknown consoles', async () => {
    const s = setup(() => Response.json({ ok: true, unknown: [] }));
    await expect(
      s.worker.handle({ id: 'r6', method: 'consoleInput', params: { consoleId: '../etc', data: 'x' } }),
    ).rejects.toThrow();
    await expect(
      s.worker.handle({
        ...start('pcn_worker03'),
        params: { ...start('pcn_worker03').params, provider: 'codex' },
      }),
    ).rejects.toThrow();
    expect(
      await s.worker.handle({
        id: 'r7',
        method: 'consoleResize',
        params: { consoleId: 'pcn_unknown1', cols: 80, rows: 24 },
      }),
    ).toMatchObject({ ok: false, code: 'provider.console_not_found' });
    expect(
      await s.worker.handle({
        id: 'r8',
        method: 'consoleStop',
        params: { consoleId: 'pcn_unknown1', reason: 'expired' },
      }),
    ).toBeNull();
  });
});

describe('SignInWorker usage probes (UI-R05)', () => {
  it('takes `usageProbe` with the contract’s params and answers the executor’s reading', async () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'wb-usage-worker-'));
    const worker = new SignInWorker({ serverUrl: 'http://127.0.0.1:1', token: 't', root });
    workers.push(worker);
    // Nobody signed in: the executor's answer, not a throw.
    expect(
      await worker.handle({
        id: 'r1',
        method: 'usageProbe',
        params: { provider: 'claude' },
      }),
    ).toMatchObject({ ok: false, code: 'provider.not_signed_in' });
    // A provider with no subscription to read: the params don't parse.
    await expect(
      worker.handle({ id: 'r2', method: 'usageProbe', params: { provider: 'github' } }),
    ).rejects.toThrow();
  });
});

describe('SignInWorker and the pods (hermes-native.md HN-W11)', () => {
  it('says a sign-in changed on a sign-out, and nothing for a request that changes none', async () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'wb-signin-change-'));
    const changed: unknown[] = [];
    const worker = new SignInWorker({
      serverUrl: 'http://127.0.0.1:1',
      token: 't',
      root,
      onLoginChange: () => changed.push('changed'),
    });
    workers.push(worker);
    await worker.handle({
      id: 'r1',
      method: 'usageProbe',
      params: { provider: 'claude' },
    });
    expect(changed).toEqual([]);
    await worker.handle({
      id: 'r2',
      method: 'logout',
      params: { provider: 'claude' },
    });
    expect(changed).toEqual(['changed']);
  });
});
