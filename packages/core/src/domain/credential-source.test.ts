import { describe, expect, it } from 'vitest';
import { DispatchCredential, SIGNIN_METHODS } from '../contracts/runner.js';
import { AgentRuntime } from './agent.js';

describe('one sign-in per provider (OP-09, CT-1503)', () => {
  it('has no credential source to pick', () => {
    const parsed = AgentRuntime.parse({
      provider: 'codex',
      credentialSource: { kind: 'org', credentialId: 'x' },
    });
    expect(parsed).toEqual({ provider: 'codex' });
  });

  it('names only the provider and how it signs in in the dispatch credential', () => {
    const credential = { v: 1, provider: 'claude', authMode: 'subscription_cli' };
    expect(DispatchCredential.parse(credential)).toEqual(credential);
    expect(Object.keys(DispatchCredential.shape).sort()).toEqual(['authMode', 'provider', 'v']);
    expect(
      DispatchCredential.parse({ ...credential, onBehalfOfAccountId: 'acc_mara0001' }),
    ).not.toHaveProperty('onBehalfOfAccountId');
  });

  it('types every sign-in method, none of them with an owner', () => {
    expect(Object.keys(SIGNIN_METHODS).sort()).toEqual(
      [
        'cancel',
        'consoleInput',
        'consoleResize',
        'consoleStart',
        'consoleStop',
        'githubToken',
        'list',
        'logout',
        'startDevice',
        'submitSecret',
        'usageProbe',
      ].sort(),
    );
    const job = {
      loginId: 'plg_12345678abcd',
      provider: 'claude',
      authMode: 'api_key',
      secret: 'sk-ant-0123456789',
      expiresAt: null,
      creatorAttested: false,
    };
    expect(SIGNIN_METHODS.submitSecret.params.safeParse(job).success).toBe(true);
    expect(SIGNIN_METHODS.submitSecret.params.parse({ ...job, owner: { kind: 'org' } })).not.toHaveProperty(
      'owner',
    );
    expect(SIGNIN_METHODS.list.params.parse({})).toEqual({});
    expect(SIGNIN_METHODS.logout.params.parse({ provider: 'codex' })).toEqual({ provider: 'codex' });
    expect(SIGNIN_METHODS.usageProbe.params.parse({ provider: 'claude' })).toEqual({ provider: 'claude' });
    expect(
      SIGNIN_METHODS.submitSecret.result.safeParse({
        ok: false,
        code: 'provider.secret_invalid',
        message: 'no',
      }).success,
    ).toBe(true);
  });
});
