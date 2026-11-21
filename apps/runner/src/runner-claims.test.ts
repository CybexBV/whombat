/**
 * A runner's claim follows what it can run (SUB-53): the server learns a runner's providers from its claims only,
 * and a claim waits at the server up to `waitMs`, so a re-check that finds a provider ready (the manager installed
 * Codex) or gone ends the waiting claim and claims again with the new list at once. After a claim that failed (the
 * server restarting) it beats before it claims again, so the server knows what it runs (HE-46).
 */

import { getEventListeners } from 'node:events';
import type { AgentProvider as ProviderKind } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { RunnerApi } from './api';
import type { ProviderRegistry } from './registry';
import { Runner, sleep } from './runner';
import { testPolicy } from './test-sandbox';

interface Claim {
  providers: string[];
  signal: AbortSignal | undefined;
  answered: boolean;
}

/** A server whose claims wait (a long poll) until the runner hangs up. */
class Api implements RunnerApi {
  claims: Claim[] = [];
  async claim(body: Parameters<RunnerApi['claim']>[0], signal?: AbortSignal) {
    const claim: Claim = { providers: [...body.providers], signal, answered: false };
    this.claims.push(claim);
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    claim.answered = true;
    return null;
  }
  async progress() {
    return { cancel: false, reason: null };
  }
  async complete() {}
  async heartbeat() {
    return { cancel: [] };
  }
  async gitCredentials(): Promise<never> {
    throw new Error('no git');
  }
}

/** A live registry whose ready providers the test sets; `recheck` reports a change once. */
function registry(initial: ProviderKind[]) {
  let ready = [...initial];
  let pending: string[] = [];
  const r: ProviderRegistry & { set(next: ProviderKind[]): void } = {
    claims: () => [...ready],
    for: () => null,
    report: () => [],
    async recheck() {
      const lines = pending;
      pending = [];
      return lines;
    },
    set(next) {
      ready = [...next];
      pending = [`ready: ${next.join(', ')}`];
    },
  };
  return r;
}

async function until<T>(read: () => T | undefined, ms = 2_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('a runner’s claims (SUB-53)', () => {
  it('claim again at once when a re-check changes the providers, and only then', async () => {
    const api = new Api();
    const reg = registry(['claude']);
    const runner = new Runner({
      api,
      registry: reg,
      serverUrl: 'http://127.0.0.1:1',
      workspacesRoot: '/nonexistent',
      managed: testPolicy(),
      waitMs: 60_000,
      heartbeatMs: 3_600_000,
    });
    runner.start();
    try {
      const first = await until(() => api.claims[0]);
      expect(first.providers).toEqual(['claude']);

      // A beat whose re-check changes nothing leaves the waiting claim alone.
      await runner.beat();
      await new Promise((r) => setTimeout(r, 50));
      expect(api.claims).toHaveLength(1);
      expect(first.answered).toBe(false);

      // Codex became ready (the manager installed it): the old claim ends, a new one asks for both.
      reg.set(['claude', 'codex']);
      await runner.beat();
      const second = await until(() => api.claims[1]);
      expect(first.answered).toBe(true);
      expect(second.providers.sort()).toEqual(['claude', 'codex']);
      expect(second.signal?.aborted).toBe(false);

      // And back: a provider that went away is no longer claimed for.
      reg.set(['claude']);
      await runner.beat();
      const third = await until(() => api.claims[2]);
      expect(second.answered).toBe(true);
      expect(third.providers).toEqual(['claude']);
    } finally {
      await runner.stop(1_000);
    }
    expect(api.claims.every((c) => c.answered)).toBe(true);
  });

  it('tells a server it couldn’t reach what it runs before it claims there again', async () => {
    const calls: string[] = [];
    let away = true;
    const api = new (class extends Api {
      override async claim() {
        calls.push(away ? 'claim (refused)' : 'claim');
        if (away) {
          away = false;
          throw new Error('connect ECONNREFUSED');
        }
        // A long poll that found nothing.
        await new Promise((r) => setTimeout(r, 20));
        return null;
      }
      override async heartbeat() {
        calls.push('heartbeat');
        return { cancel: [] };
      }
    })();
    const runner = new Runner({
      api,
      registry: registry(['claude']),
      serverUrl: 'http://127.0.0.1:1',
      workspacesRoot: '/nonexistent',
      managed: testPolicy(),
      waitMs: 10,
      heartbeatMs: 3_600_000,
    });
    runner.start();
    try {
      await until(() => (calls.filter((c) => c === 'claim').length >= 2 ? true : undefined), 5_000);
      const refused = calls.indexOf('claim (refused)');
      expect(calls.slice(refused + 1, refused + 3)).toEqual(['heartbeat', 'claim']);
    } finally {
      await runner.stop(1_000);
    }
  });
});

describe('the claim loop’s waits', () => {
  it('leave no listener on the runner’s signal once they end', async () => {
    const stopping = new AbortController();
    for (let i = 0; i < 20; i++) await sleep(1, stopping.signal);
    expect(getEventListeners(stopping.signal, 'abort')).toHaveLength(0);
    const waiting = sleep(60_000, stopping.signal);
    stopping.abort();
    await waiting;
  });
});
