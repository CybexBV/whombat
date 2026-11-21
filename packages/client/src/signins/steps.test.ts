import type { ProviderLogin } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import type { ConsoleDriverState } from './console';
import { SIGNIN_TEXT } from './copy';
import { readSignInOutput } from './guided';
import { consoleStep, deviceStep } from './steps';

const NOW = Date.parse('2026-10-30T10:00:00Z');
const login = (over: Partial<ProviderLogin> = {}): ProviderLogin => ({
  loginId: 'login_1',
  provider: 'codex',
  authMode: 'chatgpt',
  state: 'awaiting_user',
  device: {
    verificationUri: 'https://auth.openai.com/codex/device',
    userCode: 'WXYZ-1234',
    expiresAt: '2026-10-30T10:15:00Z',
  },
  error: null,
  verified: null,
  expiresAt: '2026-10-30T10:15:00Z',
  ...over,
});

describe('ChatGPT’s device code on the phone (first-day.md)', () => {
  it('shows the code, OpenAI’s page and the time left', () => {
    expect(deviceStep(login(), NOW)).toEqual({
      kind: 'code',
      code: 'WXYZ-1234',
      url: 'https://auth.openai.com/codex/device',
      host: 'auth.openai.com',
      expiresIn: '15:00',
    });
  });

  it('is done when the login completes, and over when it expires or fails', () => {
    expect(deviceStep(login({ state: 'completed' }), NOW)).toEqual({ kind: 'done' });
    expect(deviceStep(login(), Date.parse('2026-10-30T10:16:00Z'))).toEqual({
      kind: 'over',
      text: SIGNIN_TEXT.device.expired,
    });
    expect(
      deviceStep(login({ state: 'failed', error: { code: 'provider.x', message: 'No.' } }), NOW),
    ).toEqual({ kind: 'over', text: 'No.' });
  });

  it('never offers a page that isn’t OpenAI’s', () => {
    const odd = login({
      device: {
        verificationUri: 'https://example.com/device',
        userCode: 'A',
        expiresAt: '2026-10-30T10:15:00Z',
      },
    });
    expect(deviceStep(odd, NOW).kind).toBe('over');
  });
});

describe('Claude Code’s sign-in on the phone (first-day.md)', () => {
  const state = (phase: ConsoleDriverState['phase']): ConsoleDriverState => ({
    phase,
    console: null,
    error: null,
  });
  const link = readSignInOutput(
    'If the browser didn’t open, visit: https://claude.ai/oauth/authorize?code=true\n',
  );

  it('starts, offers claude.ai’s page, then checks the code it was given', () => {
    expect(consoleStep({ state: state('starting'), output: readSignInOutput(''), sent: false }).kind).toBe(
      'starting',
    );
    expect(consoleStep({ state: state('running'), output: link, sent: false })).toMatchObject({
      kind: 'open',
      host: 'claude.ai',
    });
    expect(consoleStep({ state: state('running'), output: link, sent: true }).kind).toBe('checking');
    expect(consoleStep({ state: state('completed'), output: link, sent: true }).kind).toBe('done');
  });

  it('says a refused code plainly and offers a new link', () => {
    const failed = readSignInOutput('Login failed: invalid code');
    expect(consoleStep({ state: state('running'), output: failed, sent: true })).toEqual({
      kind: 'over',
      text: SIGNIN_TEXT.console.codeFailed,
      action: SIGNIN_TEXT.console.newLink,
    });
    expect(consoleStep({ state: state('expired'), output: link, sent: false })).toMatchObject({
      kind: 'over',
    });
  });
});
