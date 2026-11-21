/**
 * The runner's long polls are held until work or the wait ends, and leave nothing behind (MR-30). Regression for the
 * managed runtime's memory growth: the request's own `close` event (fired once its body was read) aborted every poll
 * at once, so the runner's sign-in executor polled in a tight loop, and each poll's waiter stayed in the bridge.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTestServer } from '../../test/harness';
import { providerLogins } from './service';

const root = mkdtempSync(join(tmpdir(), 'wb-long-poll-'));
const t = useTestServer({
  listen: true,
  env: { WHOMBAT_CREDENTIALS_ROOT: root, WHOMBAT_SIGNIN_EXECUTOR: 'runner' },
});
const AUTH = { authorization: 'Bearer dev-runner-token', 'content-type': 'application/json' };

const post = (path: string, body: unknown, signal?: AbortSignal) =>
  fetch(`${t.baseUrl}/internal/runner${path}`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

describe('runner long polls', () => {
  it('a sign-in poll is held for its wait, then leaves no waiter behind', async () => {
    const bridge = providerLogins(t.services).bridge;
    expect(bridge).not.toBeNull();
    const started = Date.now();
    const res = await post('/signin/poll', { waitMs: 600 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requests: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    expect(bridge?.waiting).toBe(0);
  });

  it('a poll the runner hangs up on ends at once, and many in a row leave nothing behind', async () => {
    const bridge = providerLogins(t.services).bridge;
    for (let i = 0; i < 20; i++) {
      const ac = new AbortController();
      const pending = post('/signin/poll', { waitMs: 20_000 }, ac.signal).catch(() => null);
      await new Promise((r) => setTimeout(r, 20));
      ac.abort();
      await pending;
    }
    // The server sees each hang-up shortly after.
    for (let i = 0; i < 50 && (bridge?.waiting ?? 0) > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(bridge?.waiting).toBe(0);
  });

  it('a claim long poll with no work is held for its wait', async () => {
    const started = Date.now();
    const res = await post('/claim', { runnerId: 'rnr_longpoll', providers: ['claude'], waitMs: 1_500 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dispatch: null });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
  });
});
