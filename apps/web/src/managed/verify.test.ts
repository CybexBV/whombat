import { describe, expect, it } from 'vitest';
import { readVerifyFragment, verifyOnce } from './ManagedRoot';

describe('the magic link fragment', () => {
  it('reads control’s #token=…&next=… on /auth/verify only', () => {
    expect(
      readVerifyFragment({ pathname: '/auth/verify', hash: '#token=abc123&next=%2Fappliances%2Fclaim' }),
    ).toEqual({
      token: 'abc123',
      next: '/appliances/claim',
    });
    expect(readVerifyFragment({ pathname: '/auth/verify', hash: '#token=abc' })).toEqual({
      token: 'abc',
      next: '/appliances',
    });
    expect(readVerifyFragment({ pathname: '/auth/verify', hash: '' })).toBeNull();
    expect(readVerifyFragment({ pathname: '/', hash: '#token=abc' })).toBeNull();
  });

  it('never follows next off this app', () => {
    for (const next of ['https://evil.example', '//evil.example/x', 'javascript:alert(1)'])
      expect(
        readVerifyFragment({ pathname: '/auth/verify', hash: `#token=t&next=${encodeURIComponent(next)}` })
          ?.next,
      ).toBe('/appliances');
  });
});

describe('verifying a one-use token', () => {
  it('sends one request however many times it is asked (StrictMode)', async () => {
    let calls = 0;
    const env = {
      control: {
        verifySignIn: async () => {
          calls += 1;
          return { account: { accountId: 'acc_1', email: 'a@b.c', name: null }, orgs: [] };
        },
      },
    } as never;
    const [a, b] = await Promise.all([verifyOnce(env, 'tok_once'), verifyOnce(env, 'tok_once')]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });
});
