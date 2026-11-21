import { describe, expect, it } from 'vitest';
import {
  checkProviderVersion,
  classifyProviderFailure,
  FINAL_OUTCOMES,
  type ManagedOutcome,
  noSelfUpdateEnv,
  outcomeCode,
  outcomeCopy,
} from './outcomes';

describe('classifyProviderFailure', () => {
  // Messages as the CLIs and the SDK report them (Claude Code 2.1, codex-cli 0.15x), each to one outcome.
  const cases: [string, ManagedOutcome | null][] = [
    [
      'Claude exited before finishing the turn: OAuth token has expired. Please obtain a new token or refresh your existing token.',
      'auth_expired',
    ],
    [
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      'auth_expired',
    ],
    ['Invalid API key · Please run /login', 'auth_expired'],
    [
      'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
      'auth_expired',
    ],
    ['unexpected status 401 Unauthorized: {"error":{"code":"token_expired"}}', 'auth_expired'],
    ['Claude AI usage limit reached|1790000000', 'quota_exhausted'],
    ["You've hit your usage limit. Upgrade to Pro or try again in 3 hours.", 'quota_exhausted'],
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', 'quota_exhausted'],
    ['Your credit balance is too low to access the Anthropic API.', 'quota_exhausted'],
    ['exceeded retry limit, last status: 429 Too Many Requests, insufficient_quota', 'quota_exhausted'],
    [
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      'provider_outage',
    ],
    [
      'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)',
      'provider_outage',
    ],
    ['API Error: Connection error. (ECONNRESET)', 'provider_outage'],
    ['unexpected status 503 Service Unavailable', 'provider_outage'],
    ['spawn codex ENOENT', 'provider_missing'],
    [
      'Claude Code executable not found at /opt/claude. Is options.pathToClaudeCodeExecutable set?',
      'provider_missing',
    ],
    ['Codex app-server exited unexpectedly (1)', null],
    ['I could not find the file you mentioned', null],
  ];
  it.each(cases)('%s → %s', (message, outcome) => {
    expect(classifyProviderFailure(message)).toBe(outcome);
  });

  it('keeps the four owner / provider states distinct from each other', () => {
    const states = new Set(cases.map(([, o]) => o).filter(Boolean));
    expect(states).toEqual(
      new Set(['auth_expired', 'quota_exhausted', 'provider_outage', 'provider_missing']),
    );
  });
});

describe('versions', () => {
  it('detects a missing binary and drift from the pin', () => {
    expect(checkProviderVersion('2.1.282 (Claude Code)\n', '2.1.282')).toEqual({
      ok: true,
      version: '2.1.282',
      pinned: '2.1.282',
    });
    expect(checkProviderVersion('codex-cli 0.157.0', '0.156.1')).toMatchObject({
      ok: false,
      outcome: 'version_drift',
      detail: '0.157.0 instead of 0.156.1',
    });
    expect(checkProviderVersion(null, '0.156.1')).toMatchObject({ ok: false, outcome: 'provider_missing' });
    expect(checkProviderVersion('codex-cli 0.157.0', undefined)).toEqual({
      ok: true,
      version: '0.157.0',
      pinned: null,
    });
  });

  it('switches Claude Code’s self-updater off', () => {
    expect(noSelfUpdateEnv('claude')).toMatchObject({ DISABLE_AUTOUPDATER: '1' });
  });
});

describe('copy', () => {
  it('has a line and a code for every outcome, and never suggests another sign-in silently', () => {
    const all: ManagedOutcome[] = [
      'not_signed_in',
      'auth_expired',
      'quota_exhausted',
      'provider_outage',
      'provider_missing',
      'version_drift',
      'sandbox_unavailable',
      'output_limit',
      'memory_limit',
      'pids_limit',
      'wall_time',
      'lease_lost',
    ];
    const lines = new Set(all.map((o) => outcomeCopy(o, 'claude')));
    expect(lines.size).toBe(all.length);
    for (const o of all) expect(outcomeCopy(o, 'codex').length).toBeLessThanOrEqual(500);
    expect(outcomeCode('quota_exhausted')).toBe('managed:quota_exhausted');
    expect(FINAL_OUTCOMES.has('provider_outage')).toBe(false);
  });
});
