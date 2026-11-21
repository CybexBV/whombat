import type { UsageObservation } from '@whombat/agent-runtime';
import { describe, expect, it } from 'vitest';
import type { RunnerApi } from '../api';
import { testContext } from '../test-context';
import { testPolicy } from '../test-sandbox';
import type { TurnDeps } from './deps';
import { openTurn } from './scope';

type Answer = { cancel: boolean; reason: 'paused' | null };

/** The server's side of the beats: each body as sent; a beat can be held, fail, or answer stop. */
class Api implements RunnerApi {
  beats: Record<string, unknown>[] = [];
  failing = 0;
  answer: Answer = { cancel: false, reason: null };
  #held: (() => void) | null = null;
  #hold = false;

  /** The next beat waits until `release()`. */
  holdNext(): void {
    this.#hold = true;
  }
  release(): void {
    this.#held?.();
    this.#held = null;
  }
  async claim() {
    return null;
  }
  async progress(_id: string, body: Record<string, unknown>) {
    this.beats.push(body);
    if (this.failing > 0) {
      this.failing -= 1;
      throw new Error('network down');
    }
    if (this.#hold) {
      this.#hold = false;
      await new Promise<void>((r) => {
        this.#held = r;
      });
    }
    return this.answer;
  }
  async complete() {}
  async heartbeat() {
    return { cancel: [] };
  }
  async gitCredentials(): Promise<never> {
    throw new Error('no git');
  }
}

function turnOn(api: Api) {
  const deps: TurnDeps = {
    api,
    registry: { claims: () => ['claude'], for: () => null, report: () => [] },
    serverUrl: 'http://whombat.test',
    workspacesRoot: '/tmp/whombat-test-workspaces',
    managed: testPolicy(),
    log: () => {},
  };
  return openTurn(testContext(), deps);
}

const reading = (observedAt: string, usedPct: number): UsageObservation => ({
  provider: 'claude',
  kind: 'subscription',
  plan: null,
  windows: [
    {
      kind: 'five_hour',
      label: '5-hour',
      usedPct,
      resetsAt: '2100-01-01T00:00:00.000Z',
      status: 'ok',
      windowMinutes: 300,
    },
  ],
  observedAt,
  error: null,
});

describe('a turn’s beats', () => {
  it('send a rate-limit reading that came while a beat was on its way with the next one (UI-R08)', async () => {
    const api = new Api();
    const turn = turnOn(api);
    turn.readings.observe(reading('2026-10-20T10:00:00.000Z', 40));
    api.holdNext();
    const first = turn.progress.beat();
    turn.readings.observe(reading('2026-10-20T10:00:05.000Z', 41));
    api.release();
    await first;
    await turn.progress.beat();
    await turn.progress.beat();
    const sent = api.beats.map((b) => (b.rateLimits as { observedAt?: string } | undefined)?.observedAt);
    expect(sent).toEqual(['2026-10-20T10:00:00.000Z', '2026-10-20T10:00:05.000Z', undefined]);
  });

  it('carry an assessment’s exported commit until a beat with it reaches the server (review-2 F9)', async () => {
    const api = new Api();
    const turn = turnOn(api);
    turn.progress.workspaceCommit = 'a'.repeat(40);
    api.failing = 1;
    for (let i = 0; i < 3; i++) await turn.progress.beat();
    expect(api.beats.map((b) => b.workspaceCommit)).toEqual(['a'.repeat(40), 'a'.repeat(40), undefined]);
  });

  it('never stop a turn with the last word before complete; an ordinary beat does', async () => {
    const api = new Api();
    api.answer = { cancel: true, reason: 'paused' };
    const turn = turnOn(api);
    await turn.progress.beat({ final: true });
    expect(turn.stop.aborted).toBe(false);
    await turn.progress.beat();
    expect(turn.stop.reason).toBe('paused');
  });
});
