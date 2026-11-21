import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResyncSignal } from '../realtime/realtime';
import { createFakeAppliance } from './fake';
import { guardListeners } from './listeners';
import { createSessionRealtime } from './realtime';
import { createSecureSession } from './secure';
import type { ApplianceSession } from './types';

const live: ApplianceSession[] = [];
afterEach(() => {
  for (const s of live.splice(0)) s.close();
});

function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() > end) return reject(new Error('timed out waiting'));
      setTimeout(tick, 2);
    };
    tick();
  });
}

function world() {
  const errors: { error: unknown; where: string }[] = [];
  const onListenerError = (error: unknown, where: string) => errors.push({ error, where });
  const appliance = createFakeAppliance({
    account: { id: 'acc_mara', name: 'Mara' },
    handle: async () => ({ status: 200, body: {} }),
  });
  const session = createSecureSession({
    connector: appliance.connector,
    backoff: { initialMs: 2, maxMs: 5 },
    onListenerError,
  });
  live.push(session);
  return { appliance, session, errors, onListenerError };
}

describe('a listener that throws', () => {
  it('stops neither the listeners after it nor the connection, and its topic is read again', async () => {
    const { appliance, session, errors, onListenerError } = world();
    const realtime = createSessionRealtime(session, { validate: false, onListenerError });
    const statuses: string[] = [];
    realtime.onStatus((s) => statuses.push(s));
    const resyncs: ResyncSignal[] = [];
    realtime.onResync((s) => resyncs.push(s));
    const boom = new Error('reducer failed');
    realtime.onEvent(() => {
      throw boom;
    });
    const heard: unknown[] = [];
    realtime.onEvent((e) => heard.push((e as { n?: unknown }).n));
    realtime.subscribe(['conv:a']);
    realtime.connect();
    await until(() => realtime.status() === 'open');
    await new Promise((r) => setTimeout(r, 5));

    appliance.publish('conv:a', { type: 'x', n: 1 });
    appliance.publish('conv:a', { type: 'x', n: 2 });
    await until(() => heard.length === 2);

    expect(heard).toEqual([1, 2]);
    expect(errors.map((e) => [e.error, e.where])).toEqual([
      [boom, 'event'],
      [boom, 'event'],
    ]);
    expect(resyncs).toEqual([
      { reason: 'gap', topics: ['conv:a'] },
      { reason: 'gap', topics: ['conv:a'] },
    ]);
    expect(statuses).not.toContain('reconnecting');
    expect(session.state().status).toBe('open');
  });

  it('on the connection’s state leaves the other state listeners their turn', async () => {
    const { session, errors } = world();
    const boom = new Error('state listener failed');
    session.onState(() => {
      throw boom;
    });
    const seen: string[] = [];
    session.onState((s) => seen.push(s.status));
    session.connect();
    await until(() => seen.includes('open'));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.error === boom && e.where === 'state')).toBe(true);
  });

  it('goes to the console when nobody asked to be told, and a failing hook is kept in too', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('listener failed');
    const fail = () => {
      throw boom;
    };
    expect(guardListeners(undefined)('state', fail)).toBe(false);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('state'), boom);
    expect(guardListeners(fail)('state', fail)).toBe(false);
    expect(guardListeners(undefined)('state', () => {})).toBe(true);
    logged.mockRestore();
  });
});
