/**
 * The poller's cadence and its handling of heads without check runs, pure (docs/decisions/polling.md PL-01, PL-02): which
 * cadence a repo gets, when it is due, when the refresh without ETags runs, and what an empty answer for a head's check
 * runs does to its handled mark. The poller end to end is in poll-cadence.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  type CadenceSignals,
  MIN_TICK_MS,
  nextTickAt,
  pollCadence,
  pollCadences,
  pollDueAt,
  REFRESH_MAX_MS,
  REFRESH_MS,
  refreshDue,
  WAKE_GAP_MS,
} from './poll-cadence';
import { NO_CHECKS_SETTLE_MS, noChecksAfter, parseNoChecks, readChecksNow } from './poll-plan';

const quiet: CadenceSignals = {
  liveRun: false,
  freshPush: false,
  deploy: false,
  agentChecks: false,
  personActive: false,
};
const C = { fast: 10_000, active: 30_000, idle: 180_000 };

describe('a repo’s cadence (PL-01)', () => {
  it('is fast while an agent’s work is live there, active while a person is, idle otherwise', () => {
    expect(pollCadence(quiet)).toEqual({ cadence: 'idle', reason: 'quiet' });
    expect(pollCadence({ ...quiet, personActive: true })).toEqual({ cadence: 'active', reason: 'person' });
    expect(pollCadence({ ...quiet, liveRun: true })).toEqual({ cadence: 'fast', reason: 'run' });
    expect(pollCadence({ ...quiet, freshPush: true })).toEqual({ cadence: 'fast', reason: 'push' });
    expect(pollCadence({ ...quiet, deploy: true })).toEqual({ cadence: 'fast', reason: 'deploy' });
    expect(pollCadence({ ...quiet, agentChecks: true })).toEqual({ cadence: 'fast', reason: 'checks' });
    // Live work wins over a person: they see it at the fast cadence too.
    expect(pollCadence({ ...quiet, personActive: true, agentChecks: true }).cadence).toBe('fast');
  });

  it('comes from the configuration: WHOMBAT_GITHUB_POLL_MS is the active one, 0 means the active one', () => {
    const config = (active: number, fast: number, idle: number) =>
      pollCadences({
        WHOMBAT_GITHUB_POLL_MS: active,
        WHOMBAT_GITHUB_POLL_FAST_MS: fast,
        WHOMBAT_GITHUB_POLL_IDLE_MS: idle,
      });
    expect(config(30_000, 10_000, 180_000)).toEqual(C);
    expect(config(30_000, 0, 0)).toEqual({ fast: 30_000, active: 30_000, idle: 30_000 });
    // The fast cadence is never slower than the active one, the idle one never faster.
    expect(config(5_000, 10_000, 1_000)).toEqual({ fast: 5_000, active: 5_000, idle: 5_000 });
  });
});

describe('when a repo is due', () => {
  it('at once when not polled yet, else its cadence after the last poll', () => {
    expect(pollDueAt({ polledAt: null, cadence: 'idle', wokenAt: null }, C)).toBe(0);
    expect(pollDueAt({ polledAt: 1_000, cadence: 'fast', wokenAt: null }, C)).toBe(11_000);
    expect(pollDueAt({ polledAt: 1_000, cadence: 'active', wokenAt: null }, C)).toBe(31_000);
    expect(pollDueAt({ polledAt: 1_000, cadence: 'idle', wokenAt: null }, C)).toBe(181_000);
  });

  it('at once after a wake that came after its last poll, but not sooner than WAKE_GAP_MS after it', () => {
    expect(pollDueAt({ polledAt: 1_000, cadence: 'idle', wokenAt: 60_000 }, C)).toBe(60_000);
    expect(pollDueAt({ polledAt: 1_000, cadence: 'idle', wokenAt: 1_500 }, C)).toBe(1_000 + WAKE_GAP_MS);
    // A wake before the last poll was seen by it.
    expect(pollDueAt({ polledAt: 1_000, cadence: 'idle', wokenAt: 500 }, C)).toBe(181_000);
    // Never later than its own cadence.
    expect(pollDueAt({ polledAt: 1_000, cadence: 'fast', wokenAt: 30_000 }, C)).toBe(11_000);
  });

  it('the next tick is the earliest due repo, within the longest sleep and after the shortest', () => {
    expect(nextTickAt(0, [11_000, 31_000], 180_000)).toBe(11_000);
    expect(nextTickAt(0, [], 180_000)).toBe(180_000);
    expect(nextTickAt(0, [900_000], 30_000)).toBe(30_000);
    expect(nextTickAt(5_000, [0], 180_000)).toBe(5_000 + MIN_TICK_MS);
  });
});

describe('the refresh without ETags', () => {
  it('runs every ten minutes on the idle cadence only, and after thirty minutes at any cadence', () => {
    const at = (age: number, cadence: 'fast' | 'active' | 'idle') =>
      refreshDue({ refreshedAt: 1_000_000, now: 1_000_000 + age, cadence });
    expect(refreshDue({ refreshedAt: null, now: 5, cadence: 'fast' })).toBe(true);
    expect(at(REFRESH_MS - 1, 'idle')).toBe(false);
    expect(at(REFRESH_MS, 'idle')).toBe(true);
    expect(at(REFRESH_MS, 'active')).toBe(false);
    expect(at(REFRESH_MS, 'fast')).toBe(false);
    expect(at(REFRESH_MAX_MS, 'fast')).toBe(true);
    expect(at(REFRESH_MAX_MS, 'active')).toBe(true);
  });
});

describe('a head without check runs (PL-02)', () => {
  const T = 1_000_000;

  it('is remembered on the first empty answer and handled when a later poll still finds none, a minute on', () => {
    const first = noChecksAfter({ answer: 'empty', none: null, handled: false, now: T });
    expect(first).toEqual({ none: { since: T, checkedAt: T }, mark: false, unmark: false });
    // Ten seconds on (the fast cadence): CI may still be starting.
    const soon = noChecksAfter({ answer: 'unchanged', none: first.none, handled: false, now: T + 10_000 });
    expect(soon).toEqual({ none: { since: T, checkedAt: T + 10_000 }, mark: false, unmark: false });
    const later = noChecksAfter({
      answer: 'unchanged',
      none: soon.none,
      handled: false,
      now: T + NO_CHECKS_SETTLE_MS,
    });
    expect(later).toEqual({
      none: { since: T, checkedAt: T + NO_CHECKS_SETTLE_MS },
      mark: true,
      unmark: false,
    });
    // An empty answer after a refresh (no ETag) counts the same.
    expect(noChecksAfter({ answer: 'empty', none: first.none, handled: false, now: T + 180_000 }).mark).toBe(
      true,
    );
    // Handled already: nothing to mark again.
    expect(
      noChecksAfter({ answer: 'unchanged', none: later.none, handled: true, now: T + 600_000 }).mark,
    ).toBe(false);
  });

  it('a 304 for a head that had runs is nothing new', () => {
    expect(noChecksAfter({ answer: 'unchanged', none: null, handled: false, now: T })).toEqual({
      none: null,
      mark: false,
      unmark: false,
    });
  });

  it('runs that appear on a head handled without checks lift the mark; on a head handled after its round they don’t', () => {
    const none = { since: T, checkedAt: T + 60_000 };
    expect(noChecksAfter({ answer: 'runs', none, handled: true, now: T + 240_000 })).toEqual({
      none: null,
      mark: false,
      unmark: true,
    });
    // A re-run on a head whose finished round was handled wakes nobody (HW-03).
    expect(noChecksAfter({ answer: 'runs', none: null, handled: true, now: T })).toMatchObject({
      unmark: false,
    });
    // Runs before any mark: an ordinary round.
    expect(noChecksAfter({ answer: 'runs', none, handled: false, now: T + 20_000 })).toMatchObject({
      unmark: false,
      mark: false,
    });
  });

  it('is asked again on the idle rhythm once handled, and on every refresh', () => {
    const none = { since: T, checkedAt: T };
    const base = { none, handled: true, recheckMs: 180_000, refresh: false };
    expect(readChecksNow({ ...base, now: T + 10_000 })).toBe(false);
    expect(readChecksNow({ ...base, now: T + 180_000 })).toBe(true);
    expect(readChecksNow({ ...base, now: T + 10_000, refresh: true })).toBe(true);
    // Not handled yet, or a head with runs: every poll.
    expect(readChecksNow({ ...base, handled: false, now: T + 10_000 })).toBe(true);
    expect(readChecksNow({ ...base, none: null, now: T + 10_000 })).toBe(true);
  });

  it('is kept in the poll cursor as <since>/<checkedAt>', () => {
    expect(parseNoChecks('1000/2000')).toEqual({ since: 1000, checkedAt: 2000 });
    expect(parseNoChecks(undefined)).toBeNull();
    expect(parseNoChecks('W/"etag"')).toBeNull();
  });
});
