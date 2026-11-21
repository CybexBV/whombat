import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/errors';
import { RunnerBridgeError, RunnerSignInBridge } from './bridge';

const row = {
  provider: 'codex',
  meta: {
    v: 1,
    provider: 'codex',
    authMode: 'api_key',
    createdAt: '2026-09-25T10:00:00.000Z',
    expiresAt: null,
    verified: 'valid',
    verifiedAt: null,
    creatorAttested: false,
    login: null,
    signal: { state: 'outage', at: '2026-09-25T11:00:00.000Z', until: null },
  },
};

async function answerList(result: unknown) {
  const bridge = new RunnerSignInBridge(() => {}, undefined, 5_000);
  const listed = bridge.list();
  const [req] = await bridge.poll(0);
  bridge.answer(req?.id as string, { ok: true, result });
  return listed;
}

describe('runner sign-in bridge (contracts 0.5.2 CT-50)', () => {
  it('keeps a list row’s creator attestation, login and last-run signal', async () => {
    expect(await answerList([row])).toEqual([row]);
  });

  it('refuses a list row without the fields the contract requires', async () => {
    const { signal: _s, ...meta } = row.meta;
    await expect(answerList([{ ...row, meta }])).rejects.toThrow(/unexpected/);
  });
});

describe('usage probes through the runner (contracts 0.23.0 CT-155, UI-R05)', () => {
  it('asks the runner with the provider, and takes a reading the contract allows', async () => {
    const bridge = new RunnerSignInBridge(() => {}, undefined, 5_000);
    const asked = bridge.usageProbe('claude');
    const [req] = await bridge.poll(0);
    expect(req).toMatchObject({ method: 'usageProbe', params: { provider: 'claude' } });
    const usage = {
      provider: 'claude',
      kind: 'subscription',
      plan: 'pro',
      windows: [
        {
          kind: 'five_hour',
          label: '5-hour',
          usedPct: 42,
          resetsAt: '2026-09-29T16:00:00.000Z',
          status: 'ok',
          windowMinutes: 300,
        },
      ],
      observedAt: '2026-09-29T14:00:00.000Z',
      error: null,
    };
    bridge.answer(req?.id as string, { ok: true, result: { ok: true, usage } });
    expect(await asked).toEqual({ ok: true, usage });
  });

  it('an older runner doesn’t know the method: its refusal names it (the service reads it as unsupported)', async () => {
    const bridge = new RunnerSignInBridge(() => {}, undefined, 5_000);
    const asked = bridge.usageProbe('codex');
    const [req] = await bridge.poll(0);
    bridge.answer(req?.id as string, { ok: false, error: 'unknown sign-in method usageProbe' });
    await expect(asked).rejects.toThrow(/unknown sign-in method/);
  });
});

describe('what a call without the runner’s answer means (command-safety.md CS-04b)', () => {
  it('never taken by the runner: nothing was done (`unavailable`), for reads and steps alike', async () => {
    const bridge = new RunnerSignInBridge(() => {}, undefined, 20);
    await expect(bridge.logout('codex')).rejects.toMatchObject({ sessionCode: 'unavailable' });
    await expect(bridge.list()).rejects.toMatchObject({
      sessionCode: 'unavailable',
    });
  });

  it('taken and then no answer: a step that acts may have (`unknown_outcome`); a read just failed', async () => {
    const bridge = new RunnerSignInBridge(() => {}, undefined, 50);
    const logout = bridge.logout('codex');
    const list = bridge.list();
    expect((await bridge.poll(0)).map((r) => r.method)).toEqual(['logout', 'list']);
    await expect(logout).rejects.toMatchObject({ sessionCode: 'unknown_outcome' });
    await expect(list).rejects.toMatchObject({ sessionCode: 'unavailable' });
  });

  it('closing: what was queued was never run, what was taken may have been', async () => {
    const bridge = new RunnerSignInBridge(() => {}, undefined, 5_000);
    const taken = bridge.startDevice({ loginId: 'login_taken', provider: 'codex', authMode: 'subscription' });
    await bridge.poll(0);
    const queued = bridge.logout('claude');
    bridge.close();
    await expect(taken).rejects.toMatchObject({ sessionCode: 'unknown_outcome' });
    await expect(queued).rejects.toMatchObject({ sessionCode: 'unavailable' });
    await expect(bridge.cancel('login_after')).rejects.toMatchObject({ sessionCode: 'unavailable' });
  });

  it('a poll whose answer never reached the runner gives its requests back', async () => {
    const bridge = new RunnerSignInBridge(() => {}, undefined, 5_000);
    const logout = bridge.logout('codex');
    // The runner hung up before the poll answered: nothing is taken.
    const gone = new AbortController();
    gone.abort();
    expect(await bridge.poll(0, gone.signal)).toEqual([]);
    // Taken, but the answer didn't go out in full (the response closed first): back in the queue.
    const cut = new AbortController();
    const [first] = await bridge.poll(0, cut.signal);
    cut.abort();
    const [again] = await bridge.poll(0);
    expect(again?.id).toBe(first?.id);
    bridge.answer(again?.id as string, { ok: true, result: { removed: true, authMode: 'api_key' } });
    expect(await logout).toEqual({ removed: true, authMode: 'api_key' });
  });

  it('a step the runner answered with something unexpected may have happened', async () => {
    const bridge = new RunnerSignInBridge(() => {}, undefined, 5_000);
    const logout = bridge.logout('codex');
    const [req] = await bridge.poll(0);
    bridge.answer(req?.id as string, { ok: true, result: { nonsense: true } });
    await expect(logout).rejects.toMatchObject({ sessionCode: 'unknown_outcome' });
  });

  it('the runner’s own refusal is its verdict: a conflict with its reason, over REST as before', async () => {
    const bridge = new RunnerSignInBridge(() => {}, undefined, 5_000);
    const logout = bridge.logout('codex');
    const [req] = await bridge.poll(0);
    bridge.answer(req?.id as string, { ok: false, error: 'no such home' });
    const err = await logout.catch((e) => e);
    expect(err).toMatchObject({ code: 'conflict' });
    expect(err).not.toBeInstanceOf(RunnerBridgeError);
    const timedOut = await new RunnerSignInBridge(() => {}, undefined, 10).cancel('login_x').catch((e) => e);
    expect(timedOut).toBeInstanceOf(ApiError);
    expect(timedOut).toMatchObject({ code: 'conflict', status: 409 });
  });
});
