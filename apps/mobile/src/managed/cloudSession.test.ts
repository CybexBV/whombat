/** The cloud session at start (AP-920…AP-922). */
import type { ControlSession } from '@whombat/client/managed';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  awaitSession,
  CLOUD_SESSION_KEY,
  cloudSessionStore,
  keptSession,
  parseKeptSession,
  SESSION_CHECK_TIMEOUT_MS,
} from './cloudSession';
import type { SecretStore } from './keys';

const SESSION: ControlSession = {
  account: { accountId: 'acc_1', email: 'mara@example.com', name: 'Mara' },
  orgs: [{ orgId: 'org_1', name: 'Lumio' }],
};

function memoryStore(fail: { get?: boolean; set?: boolean } = {}) {
  const values = new Map<string, string>();
  const store: SecretStore = {
    get: async (k) => {
      if (fail.get) throw new Error('locked');
      return values.get(k) ?? null;
    },
    set: async (k, v) => {
      if (fail.set) throw new Error('locked');
      values.set(k, v);
    },
    remove: async (k) => {
      values.delete(k);
    },
  };
  return { store: { ...store, set: vi.fn(store.set), remove: vi.fn(store.remove) }, values };
}

describe('the kept cloud session (AP-921)', () => {
  it('keeps the account and organizations, field by field: never a token', async () => {
    const withToken = { ...SESSION, token: 'secret', account: { ...SESSION.account, token: 'x' } };
    expect(keptSession(withToken as ControlSession)).toEqual(SESSION);
    const { store, values } = memoryStore();
    await cloudSessionStore(store).set(withToken as ControlSession);
    expect(values.get(CLOUD_SESSION_KEY)).not.toContain('secret');
    expect(await cloudSessionStore(store).get()).toEqual(SESSION);
  });

  it('writes only when it changed, and clears', async () => {
    const { store, values } = memoryStore();
    const kept = cloudSessionStore(store);
    expect(await kept.get()).toBeNull();
    await kept.set(SESSION);
    await kept.set({ ...SESSION });
    expect(store.set).toHaveBeenCalledTimes(1);
    await kept.set({ ...SESSION, orgs: [...SESSION.orgs, { orgId: 'org_2', name: 'Two' }] });
    expect(store.set).toHaveBeenCalledTimes(2);
    await kept.clear();
    await kept.clear();
    expect(values.has(CLOUD_SESSION_KEY)).toBe(false);
    expect(store.remove).toHaveBeenCalledTimes(1);
  });

  it('a session too large for the store is not kept, and the older one goes', async () => {
    const { store, values } = memoryStore();
    const kept = cloudSessionStore(store);
    await kept.set(SESSION);
    const many = Array.from({ length: 60 }, (_, i) => ({
      orgId: `org_${i}`,
      name: `Org ${i}`,
    }));
    await kept.set({ ...SESSION, orgs: many });
    expect(values.has(CLOUD_SESSION_KEY)).toBe(false);
  });

  it('a keystore that refuses keeps nothing and never throws', async () => {
    const { store } = memoryStore({ get: true, set: true });
    const kept = cloudSessionStore(store);
    expect(await kept.get()).toBeNull();
    await expect(kept.set(SESSION)).resolves.toBeUndefined();
  });

  it('reads only what it wrote', () => {
    expect(parseKeptSession(JSON.stringify(SESSION))).toEqual(SESSION);
    expect(parseKeptSession(null)).toBeNull();
    expect(parseKeptSession('{')).toBeNull();
    expect(parseKeptSession(JSON.stringify({ account: SESSION.account }))).toBeNull();
    expect(parseKeptSession(JSON.stringify({ ...SESSION, orgs: [{ orgId: '', name: 'n' }] }))).toBeNull();
    expect(
      parseKeptSession(JSON.stringify({ ...SESSION, account: { email: 'x@y.z', name: null } })),
    ).toBeNull();
  });
});

describe('control’s answer at start (AP-922)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('an answer in time is the answer; signed out is an answer too', async () => {
    const on = { answered: vi.fn(), unreachable: vi.fn() };
    awaitSession(Promise.resolve(null), on);
    await vi.advanceTimersByTimeAsync(0);
    expect(on.answered).toHaveBeenCalledWith(null);
    expect(on.unreachable).not.toHaveBeenCalled();
  });

  it('no answer in time is unreachable; a late answer still counts', async () => {
    let answer: (s: ControlSession) => void = () => {};
    const on = { answered: vi.fn(), unreachable: vi.fn() };
    awaitSession(new Promise((ok) => (answer = ok)), on);
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_TIMEOUT_MS);
    expect(on.unreachable).toHaveBeenCalledTimes(1);
    answer(SESSION);
    await vi.advanceTimersByTimeAsync(0);
    expect(on.answered).toHaveBeenCalledWith(SESSION);
  });

  it('a failure is unreachable once; nothing after it was stopped', async () => {
    const on = { answered: vi.fn(), unreachable: vi.fn() };
    awaitSession(Promise.reject(new Error('offline')), on);
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_TIMEOUT_MS);
    expect(on.unreachable).toHaveBeenCalledTimes(1);

    const later = { answered: vi.fn(), unreachable: vi.fn() };
    let answer: (s: ControlSession) => void = () => {};
    const stop = awaitSession(new Promise((ok) => (answer = ok)), later);
    stop();
    answer(SESSION);
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_TIMEOUT_MS);
    expect(later.answered).not.toHaveBeenCalled();
    expect(later.unreachable).not.toHaveBeenCalled();
  });
});
