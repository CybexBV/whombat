import { describe, expect, it } from 'vitest';
import {
  classifyTurnFailure,
  claudeExtraUsageRequired,
  gatewayRoomAt,
  HERMES_PROFILE_BUSY,
  hermesProfileBusy,
} from './failures';

describe('classifyTurnFailure (essentials-agents.md EA-08)', () => {
  it('the dev monolith’s read-only sandbox helper is a sandbox failure', () => {
    // dsp_ZNgJXNi9BizP on the dev instance, 2026-09-24 (Codex, guarded).
    const error =
      "error creating thread: failed to load AGENTS.md instructions for environment `local`: fs sandbox helper failed with status exit status: 1: bwrap: Can't create file /home/alex/.whombat-dev/workspaces: Read-only file system (2026-09-24T11:35:42.172143Z ERROR codex_core::session: Failed to create session: failed to load AGENTS.md instructions for environment `local`: fs sandbox helper failed with status exit status: 1: bwrap: Can't create file /home/alex/.whombat-dev/workspaces: Read-only file system)";
    expect(classifyTurnFailure({ error })).toEqual({ code: 'sandbox' });
  });

  it.each([
    ['managed:wall_time', 'timeout'],
    ['managed:lease_lost', 'runner'],
    ['managed:quota_exhausted', 'usage_limit'],
    ['managed:not_signed_in', 'signin'],
    ['managed:provider_outage', 'provider'],
    ['managed:version_drift', 'provider'],
    ['managed:sandbox_unavailable', 'sandbox'],
    ['managed:memory_limit', 'sandbox'],
    ['provider.requester_not_signed_in', 'signin'],
    ['provider.not_configured', 'signin'],
    ['provider.trusted_personal_source', 'signin'],
    ['managed.provider_gated', 'signin'],
    ['client.not_installed', 'provider'],
    ['lease_expired', 'runner'],
    ['unrunnable:no_runner', 'runner'],
    ['unrunnable:provider', 'signin'],
    ['unrunnable:acp', 'provider'],
    ['credential_source_changed', 'signin'],
    ['context: Error: boom', 'internal'],
    ['No codex provider on this runner', 'runner'],
  ] as const)('code %s → %s', (error, code) => {
    expect(classifyTurnFailure({ error }).code).toBe(code);
  });

  it.each([
    ['checkout', 'workspace'],
    ['workspace_busy', 'workspace'],
    ['work_folder_not_private', 'workspace'],
    ['sandbox_unavailable', 'sandbox'],
    ['scratch_not_private', 'sandbox'],
    ['lease_lost', 'runner'],
  ] as const)('a refusal coded %s (sent as host_not_ready) → %s', (refusalCode, code) => {
    expect(classifyTurnFailure({ error: 'host_not_ready', refusalCode }).code).toBe(code);
  });

  it.each([
    ['Claude AI usage limit reached|1790330400', 'usage_limit'],
    ['You’ve hit your usage limit. Upgrade to Pro or try again in 2 hours.', 'usage_limit'],
    ['Invalid API key · Please run /login (HTTP 401)', 'signin'],
    ['Your access token could not be refreshed because your refresh token was already used.', 'signin'],
    ['API Error: 529 Overloaded', 'provider'],
    ['stream disconnected before completion: error sending request', 'provider'],
    ['spawn codex ENOENT', 'provider'],
    // Fusebox 0.14's 503 when a stalled upstream is all that keeps the model away: a hiccup, not a pool without room.
    [
      'the upstream for claude-opus-5-5 stalled (it sent nothing before the first-token deadline); next try in 45s',
      'provider',
    ],
    // Fusebox 0.17 at a restart: the 503 before an answer, and the error event ending an answer it cut short.
    ['Fusebox is restarting; try again', 'provider'],
    [
      'API Error: {"type":"error","error":{"type":"api_error","message":"Fusebox stopped before the answer was complete"}}',
      'provider',
    ],
    ['fatal: could not read from remote repository.', 'workspace'],
    // The engine's content/safety refusal: the model declined the request, not an outage or a limit.
    [
      '⚠️ Claude Code through Whombat’s AI gateway’s safety filter refused this request, so the model didn’t answer. Try rewording your message or removing sensitive attachments, or switch to another model with /model. Provider said: Cyber safeguards flagged this message.',
      'refused',
    ],
    ['The request was declined to respond to by the content policy.', 'refused'],
    ['Something odd happened', 'internal'],
  ] as const)('message %j → %s', (error, code) => {
    expect(classifyTurnFailure({ error }).code).toBe(code);
  });

  it('the provider’s credential signal wins over the words, and a usage limit carries its reset', () => {
    expect(
      classifyTurnFailure({
        error: 'Claude did not complete the turn.',
        credentialState: 'quota_exhausted',
        credentialUntil: '2026-09-30T16:00:00.000Z',
      }),
    ).toEqual({ code: 'usage_limit', resetsAt: '2026-09-30T16:00:00.000Z' });
    expect(classifyTurnFailure({ error: 'x', credentialState: 'auth_expired' }).code).toBe('signin');
    expect(classifyTurnFailure({ error: 'x', credentialState: 'outage' }).code).toBe('provider');
    expect(classifyTurnFailure({ error: 'x', managedOutcome: 'wall_time' }).code).toBe('timeout');
  });

  it('Fusebox with no room for the model is a usage limit, which has room again when it says (AIG-D31)', () => {
    // dsp_FsqkOCGZbbPM on Home, 2026-10-25: Hermes's words around Fusebox's 429.
    const error =
      'custom rate-limited every one of 3 attempts — it looks temporarily unavailable. Provider said: HTTP 429: all accounts for claude-opus-5-5 are rate limited; next available in 2949s';
    expect(classifyTurnFailure({ error }).code).toBe('usage_limit');
    const now = new Date('2026-10-25T15:00:51.000Z');
    expect(gatewayRoomAt(error, now)).toBe('2026-10-25T15:50:00.000Z');
    expect(gatewayRoomAt('API Error: 429 Too Many Requests', now)).toBeNull();
  });

  it.each(['your ', ''])(
    'Claude’s third-party extra-usage refusal (%splan) needs an account action, not a reset',
    (whose) => {
      const error =
        `custom rejected this request as malformed. Provider said: HTTP 400: Third-party apps now draw from ${whose}extra usage, not ${whose}plan limits. ` +
        'Add more at claude.ai/settings/usage and keep going.';
      expect(claudeExtraUsageRequired(error)).toBe(true);
      expect(classifyTurnFailure({ error, credentialUntil: '2026-10-26T10:00:00.000Z' })).toEqual({
        code: 'usage_limit',
        resetsAt: null,
      });
    },
  );

  it.each([
    'HTTP 400: Invalid tool schema',
    'HTTP 429: Long context requires extra usage',
    'HTTP 429: all accounts for claude-opus-5-5 are rate limited; next available in 60s',
  ])('does not confuse other refusals with the third-party billing gate: %s', (error) => {
    expect(claudeExtraUsageRequired(error)).toBe(false);
  });
});

describe('a Hermes profile that stayed busy (outsiders-turns.md)', () => {
  it('is told apart by its own words, and only by them', () => {
    expect(hermesProfileBusy(HERMES_PROFILE_BUSY)).toBe(true);
    expect(hermesProfileBusy(` ${HERMES_PROFILE_BUSY}\n`)).toBe(true);
    expect(hermesProfileBusy('I’m still busy with something else.')).toBe(false);
    expect(hermesProfileBusy(null)).toBe(false);
    // An ordinary failure, as before: nothing in its words names a code.
    expect(classifyTurnFailure({ error: HERMES_PROFILE_BUSY }).code).toBe('internal');
  });
});
