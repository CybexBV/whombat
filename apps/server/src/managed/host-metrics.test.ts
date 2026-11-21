/**
 * Reading the manager's measurements (docs/decisions/box-status.md BS-06): the request carries the range, `since` and
 * the zone; a manager that is older (404), slow (2 s) or answers what the contract doesn't allow makes them
 * `unavailable`, logged at most once a minute.
 */
import { HostMetricsResponse } from '@whombat/control-contracts/local';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Services } from '../services';
import { HOST_METRICS_TIMEOUT_MS, HostMetricsService } from './host-metrics';
import { ManagerCallError, type ManagerPort } from './ports';
import { sampleHostMetrics } from './testing';

function setup(answer: (request: unknown) => Promise<unknown>) {
  let now = new Date('2026-10-11T10:00:00.000Z').getTime();
  const warn = vi.fn();
  const debug = vi.fn();
  const requests: unknown[] = [];
  const manager = {
    hostMetrics: async (request: unknown) => {
      requests.push(request);
      return HostMetricsResponse.parse(await answer(request));
    },
  } as unknown as ManagerPort;
  const services = { clock: () => new Date(now), log: { warn, debug } } as unknown as Services;
  return {
    host: new HostMetricsService(services, manager),
    warn,
    debug,
    requests,
    later: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the manager’s measurements (BS-06)', () => {
  it('asks for the range in the zone, passes `since` through and hands the answer on', async () => {
    const metrics = sampleHostMetrics({ range: 'day', timeZone: 'Europe/Amsterdam' });
    const s = setup(async () => ({ v: 1, metrics }));
    expect(await s.host.read({ range: 'day', since: '2026-10-11T09:55:00Z' }, 'Europe/Amsterdam')).toEqual({
      metrics,
      reason: null,
    });
    expect(await s.host.read({ range: 'hour' }, 'UTC')).toMatchObject({ reason: null });
    expect(s.requests).toEqual([
      { v: 1, range: 'day', since: '2026-10-11T09:55:00Z', timeZone: 'Europe/Amsterdam' },
      { v: 1, range: 'hour', timeZone: 'UTC' },
    ]);
    expect(s.warn).not.toHaveBeenCalled();
  });

  it('is unavailable from an older manager (404) or an answer the contract doesn’t allow', async () => {
    const older = setup(async () => {
      throw new ManagerCallError('/v1/host/metrics', 404, 'not_found', 'manager: 404');
    });
    expect(await older.host.read({ range: 'hour' }, 'UTC')).toEqual({ metrics: null, reason: 'unavailable' });
    expect(older.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404 }),
      'host metrics: this manager doesn’t measure the box yet',
    );
    const odd = setup(async () => ({ v: 1, metrics: { now: 'busy' } }));
    expect(await odd.host.read({ range: 'hour' }, 'UTC')).toEqual({ metrics: null, reason: 'unavailable' });
  });

  it('a manager that hasn’t measured the box yet is no warning (it just started)', async () => {
    const s = setup(async () => {
      throw new ManagerCallError('/v1/host/metrics', 503, 'unavailable', 'the box hasn’t been measured yet');
    });
    expect(await s.host.read({ range: 'hour' }, 'UTC')).toEqual({ metrics: null, reason: 'unavailable' });
    expect(s.warn).not.toHaveBeenCalled();
    expect(s.debug).toHaveBeenCalledTimes(1);
  });

  it('waits 2 seconds at most', async () => {
    vi.useFakeTimers();
    const s = setup(() => new Promise(() => {}));
    const answer = s.host.read({ range: 'week' }, 'UTC');
    await vi.advanceTimersByTimeAsync(HOST_METRICS_TIMEOUT_MS - 1);
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toEqual({ metrics: null, reason: 'unavailable' });
    expect(s.warn).toHaveBeenCalledWith(expect.anything(), 'host metrics: the manager didn’t answer');
  });

  it('says so in the log at most once a minute, not at every poll', async () => {
    const s = setup(async () => {
      throw new ManagerCallError('/v1/host/metrics', 0, 'unreachable', 'connect ENOENT');
    });
    for (let i = 0; i < 6; i++) {
      await s.host.read({ range: 'hour' }, 'UTC');
      s.later(10_000);
    }
    expect(s.warn).toHaveBeenCalledTimes(1);
    s.later(1_000);
    await s.host.read({ range: 'hour' }, 'UTC');
    expect(s.warn).toHaveBeenCalledTimes(2);
  });
});
