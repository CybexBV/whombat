import { ApiError, NetworkError } from '@whombat/client';
import { type Agent, DEFAULT_FEEDBACK_LIMITS } from '@whombat/core/domain';
import { dusty, feedbackIntegration } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { errorText } from './copy';
import {
  assessorProblem,
  emptyForm,
  formOf,
  LIMIT_KEYS,
  limitBounds,
  originLines,
  serverErrors,
  settingsInput,
} from './settingsForm';

const agent = (patch: Partial<Agent> = {}): Agent => ({
  ...dusty,
  runtime: { ...dusty.runtime, provider: 'claude' },
  ...patch,
});

describe('settings form', () => {
  it('reads the server’s field errors, with or without the settings prefix', () => {
    const input = settingsInput(formOf(feedbackIntegration));
    expect(
      serverErrors(
        {
          'settings.allowedOrigins.1': ['Not allowed.'],
          'settings.agentId': ['Dusty is not in #incidents.'],
          'limits.reportsPerDay': ['Too many.'],
        },
        input,
      ),
    ).toEqual({
      allowedOrigins: ['“http://localhost:5173”: Not allowed.'],
      agentId: ['Dusty is not in #incidents.'],
      'limits.reportsPerDay': ['Too many.'],
    });
  });

  it('shows each origin line’s canonical form', () => {
    expect(originLines('HTTPS://App.Example.com:443/\n\nhttp://localhost:5173\nhttp://example.com')).toEqual([
      { line: 'HTTPS://App.Example.com:443/', origin: 'https://app.example.com' },
      { line: 'http://localhost:5173', origin: 'http://localhost:5173' },
      { line: 'http://example.com', origin: null },
    ]);
  });

  it('takes limit bounds and defaults from the schema', () => {
    expect(LIMIT_KEYS).toHaveLength(Object.keys(DEFAULT_FEEDBACK_LIMITS).length);
    expect(limitBounds('reportsPerDay')).toEqual({ min: 1, max: 10_000, fallback: 200 });
    expect(limitBounds('maxAttachmentBytes')).toEqual({ min: 64, max: 8192, fallback: 3072 });
    expect(limitBounds('assessmentsPerDay')).toEqual({ min: 0, max: 500, fallback: 50 });
  });
});

describe('the agent', () => {
  it('assesses only with Claude Code or ChatGPT (FB-18, FB-A03, HE-36; AP-5617)', () => {
    expect(assessorProblem(agent())).toBeNull();
    expect(assessorProblem(agent({ runtime: { ...agent().runtime, provider: 'codex' } }))).toBeNull();
    expect(assessorProblem(agent({ runtime: { ...agent().runtime, provider: 'local' } }))).toContain(
      'ChatGPT',
    );
  });

  it('sends whether the agent builds the fix, and no agent or channel (one-agent.md AP-4935, AP-4936)', () => {
    const form = { ...emptyForm(), name: 'Docs', productLabel: 'Docs', origins: 'https://d.example' };
    expect(settingsInput(form, { handoff: 'off' })).toMatchObject({ handoff: 'off' });
    expect(settingsInput(form)).toMatchObject({ handoff: 'on' });
    const sent = settingsInput(form);
    for (const field of ['channelId', 'agentId', 'handoffAgentId']) expect(field in sent).toBe(false);
  });
});

describe('copy', () => {
  it('says honestly when the server can’t do it yet, or the report is out of reach', () => {
    const notBuilt = new ApiError(501, 'not_implemented', 'Not implemented', {}, 'feedback.retryAssessment');
    expect(errorText(notBuilt, { notAvailable: 'Not on this Whombat yet.' })).toBe(
      'Not on this Whombat yet.',
    );
    const gone = new ApiError(404, 'not_found', 'Not found', {}, 'feedback.getReport');
    expect(errorText(gone, { notFound: 'You can’t see this report.' })).toBe('You can’t see this report.');
    const conflict = new ApiError(409, 'conflict', 'Only a failed assessment can be retried.', {}, 'x');
    expect(errorText(conflict)).toBe('Only a failed assessment can be retried.');
    expect(errorText(new NetworkError('x', new Error('offline')))).toBe(
      'Couldn’t reach Whombat. Nothing changed, try again.',
    );
  });
});

describe('pages visited and reporter sign-in (CT-161, CT-162)', () => {
  it('start on, round-trip through the form and go to the server', () => {
    expect(emptyForm()).toMatchObject({ trail: 'on', reporterSignIn: 'on' });
    const off = { ...feedbackIntegration, trail: 'off' as const, reporterSignIn: 'off' as const };
    expect(formOf(off)).toMatchObject({ trail: 'off', reporterSignIn: 'off' });
    expect(settingsInput(formOf(off))).toMatchObject({ trail: 'off', reporterSignIn: 'off' });
    expect(settingsInput(formOf(feedbackIntegration))).toMatchObject({ trail: 'on', reporterSignIn: 'on' });
  });
});
