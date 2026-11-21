import { describe, expect, it } from 'vitest';
import { GITHUB_SIGNIN_TEXT, githubModeAvailable, githubSignInOf, githubSignInUrl } from './github';
import type { SignInsList } from './model';

const signIn = (over: Record<string, unknown>) => ({
  provider: 'github' as const,
  authMode: 'device',
  createdAt: '2026-09-30T09:00:00Z',
  expiresAt: null,
  verified: 'valid' as const,
  login: 'maraokafor',
  state: 'ready' as const,
  explanation: null,
  ...over,
});

describe('a person’s own GitHub sign-in (essentials item 6, CT-181)', () => {
  it('only gives github.com pages over https a button', () => {
    expect(githubSignInUrl('https://github.com/login/device')).toBe('https://github.com/login/device');
    expect(githubSignInUrl(' https://gist.github.com/x ')).toBe('https://gist.github.com/x');
    expect(githubSignInUrl('http://github.com/login/device')).toBeNull();
    expect(githubSignInUrl('https://github.com.evil.example/login/device')).toBeNull();
    expect(githubSignInUrl('https://notgithub.com/')).toBeNull();
    expect(githubSignInUrl('https://user:pw@github.com/')).toBeNull();
    expect(githubSignInUrl('nonsense')).toBeNull();
  });

  it('reads the person’s own GitHub sign-in, a ready one first', () => {
    const list = {
      signIns: [
        signIn({ state: 'auth_expired', login: 'old' }),
        signIn({}),
        { ...signIn({}), provider: 'claude' as const },
      ],
      logins: [],
      modes: [],
      consoles: [],
    } as unknown as SignInsList;
    expect(githubSignInOf(list)?.login).toBe('maraokafor');
    expect(githubSignInOf({ ...list, signIns: [list.signIns[0]] } as SignInsList)?.state).toBe(
      'auth_expired',
    );
    expect(githubSignInOf(undefined)).toBeNull();
  });

  it('offers a mode unless the runtime says it isn’t available', () => {
    const list = {
      signIns: [],
      logins: [],
      modes: [{ provider: 'github', authMode: 'token', available: false, reason: 'No.' }],
      consoles: [],
    } as unknown as SignInsList;
    expect(githubModeAvailable(list, 'token')).toBe(false);
    expect(githubModeAvailable(list, 'device')).toBe(true);
    expect(githubModeAvailable(undefined, 'device')).toBe(true);
  });

  it('says who the connection acts as', () => {
    expect(GITHUB_SIGNIN_TEXT.signedInAs('maraokafor')).toBe('Signed in as @maraokafor');
    expect(GITHUB_SIGNIN_TEXT.dev.readyToConnect('maraokafor')).toBe(
      'You’re signed in to GitHub as @maraokafor. Connect it to bring in repos; everything on GitHub happens as @maraokafor.',
    );
  });
});
