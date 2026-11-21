import { describe, expect, it } from 'vitest';
import {
  AUTH_MODES,
  type Classification,
  credentialStatus,
  ELIGIBILITY_REGISTER,
  providerEligibility,
  signInEligibility,
  stateFromClaudeSignal,
  stateFromHttpStatus,
  WORKFLOWS,
  workflowOf,
} from './index';

/**
 * The register as the test states it, independently of `ELIGIBILITY_REGISTER` (provider-evidence.md, 2026-09-25;
 * the subscription rows per provider-subscriptions.md SUB-01, 2026-09-26): the person's PI / NA (one-person.md OP-09).
 */
const EXPECTED: Record<string, [Classification, Classification]> = {
  'claude:api_key': ['permitted', 'permitted'],
  'claude:cloud': ['permitted', 'permitted'],
  'claude:subscription_sdk': ['excluded', 'excluded'],
  'claude:subscription_cli': ['permitted', 'permitted'],
  'codex:api_key': ['permitted', 'permitted'],
  'codex:chatgpt': ['permitted', 'permitted'],
  'codex:access_token': ['permitted_candidate', 'permitted_candidate'],
};

describe('eligibility policy (the full matrix)', () => {
  const combos = (['claude', 'codex'] as const).flatMap((provider) =>
    AUTH_MODES[provider].map((authMode) => ({ provider, authMode })),
  );

  it('covers every model provider × mode, and the register has no other rows', () => {
    expect(combos.map((c) => `${c.provider}:${c.authMode}`).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(ELIGIBILITY_REGISTER.map((r) => `${r.provider}:${r.authMode}`).sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );
  });

  for (const { provider, authMode } of combos) {
    const expected = EXPECTED[`${provider}:${authMode}`] as Classification[];
    const cases = WORKFLOWS.map((workflow, i) => ({ workflow, want: expected[i] as Classification }));
    for (const c of cases) {
      it(`${provider} ${authMode} ${c.workflow}: ${c.want}`, () => {
        const managed = providerEligibility({ provider, authMode, workflow: c.workflow });
        expect(managed.classification).toBe(c.want);
        const runs = c.want === 'permitted' || c.want === 'permitted_candidate';
        expect(managed.allowed).toBe(runs);
        if (runs) {
          expect(managed.code).toBeNull();
          expect(managed.explanation).toBeNull();
        } else {
          expect(managed.code).toBe(
            c.want === 'gated' ? 'managed.provider_gated' : 'managed.provider_excluded',
          );
          expect(managed.explanation).toMatch(/\S/);
          // People's copy uses typographic apostrophes, never straight ones.
          expect(managed.explanation).not.toMatch(/'/);
        }
      });
    }
  }

  it('fails closed on anything not in the register', () => {
    for (const [provider, authMode] of [
      ['codex', 'pooled'],
      ['claude', 'oauth_proxy'],
      ['acp', 'api_key'],
      ['scripted', 'api_key'],
    ] as const) {
      const v = providerEligibility({ provider, authMode, workflow: 'PI' });
      expect(v).toMatchObject({
        classification: 'excluded',
        allowed: false,
        code: 'managed.provider_excluded',
      });
    }
  });

  it('refuses a sign-in whose every workflow is refused, and allows the rest', () => {
    const at = (provider: 'claude' | 'codex' | 'github', authMode: string) =>
      signInEligibility({ provider, authMode }).allowed;
    expect(at('claude', 'api_key')).toBe(true);
    expect(at('claude', 'subscription_sdk')).toBe(false);
    // SUB-01: the person's own subscription may be signed in to.
    expect(at('claude', 'subscription_cli')).toBe(true);
    expect(at('codex', 'chatgpt')).toBe(true);
    expect(at('codex', 'access_token')).toBe(true);
    expect(at('github', 'device')).toBe(true);
  });
});

describe('the workflow of a turn (one-person.md OP-09)', () => {
  it('the person’s asking and what carries it on is PI; their automations and outsiders’ input NA', () => {
    for (const trigger of [
      'mention',
      'dm',
      'search',
      'expand',
      'notify',
      'approval_granted',
      'vault_pass',
      'retry',
    ])
      expect(workflowOf(trigger), trigger).toBe('PI');
    for (const trigger of ['automation', 'schedule', 'feedback'])
      expect(workflowOf(trigger), trigger).toBe('NA');
  });
});

describe('credential states from provider signals', () => {
  it('maps Claude SDK errors and statuses', () => {
    expect(stateFromClaudeSignal({ error: 'authentication_failed' })).toBe('auth_revoked');
    expect(stateFromClaudeSignal({ error: 'billing_error' })).toBe('quota_exhausted');
    expect(stateFromClaudeSignal({ error: 'overloaded' })).toBe('outage');
    expect(stateFromClaudeSignal({ error: 'rate_limit', httpStatus: 429 })).toBeNull();
    expect(stateFromClaudeSignal({ error: 'unknown', httpStatus: 529 })).toBe('outage');
    expect(stateFromClaudeSignal({ httpStatus: 402 })).toBe('quota_exhausted');
    expect(stateFromClaudeSignal({ message: 'OAuth token has expired. Please log in again.' })).toBe(
      'auth_expired',
    );
  });

  it('maps HTTP statuses', () => {
    expect(stateFromHttpStatus(503)).toBe('outage');
    expect(stateFromHttpStatus(401)).toBe('auth_revoked');
    expect(stateFromHttpStatus(429)).toBeNull();
  });

  const base = {
    refused: null,
    drift: null,
    signedIn: true,
    expiresAt: null,
    signal: null,
    now: new Date('2026-09-25T12:00:00Z'),
  };
  const names = { provider: 'ChatGPT' };

  it('puts what must be fixed first: policy, drift, sign-in, expiry, then the last run', () => {
    expect(
      credentialStatus({ ...base, refused: { explanation: 'gated!' }, drift: { explanation: 'd' } }, names),
    ).toEqual({
      state: 'gated',
      explanation: 'gated!',
    });
    expect(credentialStatus({ ...base, drift: { explanation: 'drift' }, signedIn: false }, names).state).toBe(
      'version_drift',
    );
    expect(credentialStatus({ ...base, signedIn: false }, names).state).toBe('not_signed_in');
    expect(credentialStatus({ ...base, expiresAt: '2026-09-25T11:59:59Z' }, names).state).toBe(
      'auth_expired',
    );
    expect(
      credentialStatus(
        {
          ...base,
          signal: { state: 'quota_exhausted', at: '2026-09-25T10:00:00Z', until: '2026-09-25T13:00:00Z' },
        },
        names,
      ).state,
    ).toBe('quota_exhausted');
    // A signal whose time has passed no longer holds.
    expect(
      credentialStatus(
        { ...base, signal: { state: 'outage', at: '2026-09-25T10:00:00Z', until: '2026-09-25T11:00:00Z' } },
        names,
      ).state,
    ).toBe('ready');
    expect(credentialStatus(base, names)).toEqual({ state: 'ready', explanation: null });
  });

  it('speaks to the person, and never suggests another sign-in or a paid key', () => {
    const quota = credentialStatus(
      { ...base, signal: { state: 'quota_exhausted', at: '2026-09-25T10:00:00Z', until: null } },
      names,
    ).explanation;
    expect(quota).toMatch(/^Your ChatGPT/);
    expect(quota).toContain('doesn’t switch to another sign-in or a paid key');
  });
});
