import { describe, expect, it } from 'vitest';
import { createHttpControl, storageTokenStore, type TokenStore } from './control';

const TOKEN = 'x'.repeat(40);
const OLDER = 'o'.repeat(40);

/** Control answering verify and session; records the bearer token each request carried. */
function controlWith(tokens: TokenStore) {
  const auth: (string | null)[] = [];
  const control = createHttpControl('http://control.test', {
    tokens,
    fetch: async (url, init) => {
      auth.push(((init?.headers ?? {}) as Record<string, string>).authorization ?? null);
      const session = { account: { accountId: 'acc_1', email: 'a@b.c', name: null }, orgs: [] };
      if (url.endsWith('/v1/auth/verify'))
        return new Response(JSON.stringify({ token: TOKEN, expiresAt: '2026-10-01T00:00:00Z', ...session }));
      if (url.endsWith('/v1/auth/session')) return new Response(JSON.stringify(session));
      return new Response(JSON.stringify({ ok: true }));
    },
  });
  return { control, auth };
}

/** A token store that can be made to fail, like the browser's storage or the phone's keystore can. */
function failing(initial: string | null = null) {
  const state = { token: initial, get: false, set: false, remove: false };
  const store: TokenStore = {
    get: async () => {
      if (state.get) throw new Error('keystore unavailable');
      return state.token;
    },
    set: async (t) => {
      if (state.set) throw new Error('quota exceeded');
      state.token = t;
    },
    remove: async () => {
      if (state.remove) throw new Error('keystore unavailable');
      state.token = null;
    },
  };
  return { store, state };
}

describe('the cloud token when its store fails (AP-594)', () => {
  it('a token that can’t be stored still signs this page in, and an older one doesn’t stand in after a reload', async () => {
    const t = failing(OLDER);
    t.state.set = true;
    const { control, auth } = controlWith(t.store);
    await expect(control.verifySignIn('tok_1')).resolves.toMatchObject({ account: { accountId: 'acc_1' } });
    expect(await control.session()).toMatchObject({ account: { accountId: 'acc_1' } });
    expect(auth.at(-1)).toBe(`Bearer ${TOKEN}`);
    // Not stored: a reload has no token (the older account's is gone too), so it signs in again.
    expect(t.state.token).toBeNull();
  });

  it('a token that can’t be read is none: signed out, never a failure', async () => {
    const t = failing(TOKEN);
    t.state.get = true;
    const { control } = controlWith(t.store);
    await expect(control.session()).resolves.toBeNull();
  });

  it('a sign-out whose remove fails still signs this page out', async () => {
    const t = failing(TOKEN);
    const { control } = controlWith(t.store);
    t.state.remove = true;
    await expect(control.signOut()).resolves.toBeUndefined();
    await expect(control.session()).resolves.toBeNull();
  });

  it('the browser’s store reaches local storage only when used, and never throws', async () => {
    const unreachable = () => {
      throw new Error('SecurityError: The operation is insecure.');
    };
    const store = storageTokenStore(unreachable);
    const { control } = controlWith(store);
    await expect(control.session()).resolves.toBeNull();
    await expect(control.verifySignIn('tok_1')).resolves.toMatchObject({ account: { accountId: 'acc_1' } });
    expect(await control.session()).toMatchObject({ account: { accountId: 'acc_1' } });
  });
});
