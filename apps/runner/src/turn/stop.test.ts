import { type AgentProvider, BASIC_CAPABILITIES } from '@whombat/agent-runtime';
import { RUNNER_SHUTDOWN } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { RunnerApi } from '../api';
import { testContext } from '../test-context';
import { testPolicy } from '../test-sandbox';
import { runDispatch } from '../turn';
import { TurnStop } from './stop';

describe('how a turn stops', () => {
  it('stops at once on a shutdown, and the first reason counts', () => {
    const stop = new TurnStop();
    const runner = new AbortController();
    const ask = vi.fn(async () => {});
    stop.follow(runner.signal, ask);
    runner.abort('shutdown');
    expect(stop.aborted).toBe(true);
    expect(stop.reason).toBe('shutdown');
    stop.stop('paused');
    expect(stop.reason).toBe('shutdown');
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks the server why before a cancel stops it: a pause it hears is the reason', async () => {
    const stop = new TurnStop();
    const runner = new AbortController();
    const running: boolean[] = [];
    stop.follow(runner.signal, async () => {
      running.push(!stop.aborted);
      stop.stop('paused');
    });
    runner.abort('cancelled');
    await vi.waitFor(() => expect(stop.aborted).toBe(true));
    expect(running).toEqual([true]);
    expect(stop.reason).toBe('paused');
  });

  it('is cancelled when the server says nothing more', async () => {
    const stop = new TurnStop();
    const runner = new AbortController();
    stop.follow(runner.signal, async () => {});
    runner.abort('cancelled');
    await vi.waitFor(() => expect(stop.aborted).toBe(true));
    expect(stop.reason).toBe('cancelled');
  });

  it('lets go of the runner’s signal once the turn ended', () => {
    const stop = new TurnStop();
    const runner = new AbortController();
    const stopped = vi.fn();
    stop.onStop(stopped);
    stop.follow(runner.signal, async () => {});
    stop.unfollow();
    runner.abort('shutdown');
    expect(stop.aborted).toBe(false);
    expect(stopped).not.toHaveBeenCalled();
  });
});

describe('a turn the runner stopped before it began', () => {
  class Api implements RunnerApi {
    beats: Record<string, unknown>[] = [];
    completed: Record<string, unknown>[] = [];
    async claim() {
      return null;
    }
    async progress(_id: string, body: Record<string, unknown>) {
      this.beats.push(body);
      return { cancel: true, reason: 'paused' as const };
    }
    async complete(_id: string, body: Record<string, unknown>) {
      this.completed.push(body);
    }
    async heartbeat() {
      return { cancel: [] };
    }
    async gitCredentials(): Promise<never> {
      throw new Error('no git');
    }
  }
  /** A provider that waits until the turn is stopped; whether it got to run is what each test checks. */
  const hanging = () => {
    const ran: boolean[] = [];
    const p: AgentProvider = {
      kind: 'claude',
      available: async () => ({ ok: true, version: 'test' }),
      capabilities: () => BASIC_CAPABILITIES,
      async *runTurn(_input, signal) {
        ran.push(true);
        if (!signal.aborted) await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
      },
    };
    return { p, ran };
  };
  const deps = (api: Api, p: AgentProvider) => ({
    api,
    registry: {
      claims: () => ['claude' as const],
      for: () => p,
      report: () => [],
      // The scripted Hermes (HE-46): turns the server sent without a sign-in run on no one's.
      hermesScripted: () => true,
    },
    serverUrl: 'http://whombat.test',
    workspacesRoot: '/tmp/whombat-test-workspaces',
    managed: testPolicy(),
    log: () => {},
    progressMs: 60_000,
  });

  it('asks the server why a cancel came, and ends as it says, without running the provider', async () => {
    const api = new Api();
    const { p, ran } = hanging();
    const runner = new AbortController();
    runner.abort('cancelled');
    const out = await runDispatch(testContext(), deps(api, p), runner.signal);
    expect(out).toMatchObject({ outcome: 'cancelled', reason: 'paused' });
    expect(api.beats.length).toBeGreaterThan(0);
    expect(api.completed).toEqual([expect.objectContaining({ outcome: 'cancelled' })]);
    expect(ran).toEqual([]);
  });

  it('hands a turn back on shutdown without running the provider', async () => {
    const api = new Api();
    const { p, ran } = hanging();
    const runner = new AbortController();
    runner.abort('shutdown');
    const out = await runDispatch(testContext(), deps(api, p), runner.signal);
    expect(out).toMatchObject({ outcome: 'failed', reason: 'shutdown', error: RUNNER_SHUTDOWN });
    expect(api.completed).toEqual([expect.objectContaining({ outcome: 'failed', error: RUNNER_SHUTDOWN })]);
    expect(ran).toEqual([]);
  });
});
