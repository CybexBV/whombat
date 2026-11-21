import { PROVIDER_LABELS } from '@whombat/core/domain';
import { providerStateLabel } from '@whombat/core/text';
import { describe, expect, it } from 'vitest';
import { ANY_PROVIDER, CLIENT_NAMES, SIGNIN_TEXT, SOURCE_TEXT } from './copy';

describe('ChatGPT is a provider people sign in to, not a client (chatgpt-no-client.md AP-5611…AP-5613)', () => {
  it('names it ChatGPT wherever the app shows a provider, and keeps Claude Code', () => {
    expect({ claude: CLIENT_NAMES.claude, codex: CLIENT_NAMES.codex }).toEqual({
      claude: 'Claude Code',
      codex: 'ChatGPT',
    });
    expect(PROVIDER_LABELS.local).toMatch(/network/);
    expect(ANY_PROVIDER).toBe('Claude Code or ChatGPT');
  });

  it('calls the device code OpenAI’s own sign-in, and never asks to install it', () => {
    expect(SIGNIN_TEXT.device.label).toBe('ChatGPT sign-in');
    expect(SIGNIN_TEXT.device.trust).toContain('OpenAI’s own sign-in');
    expect(SIGNIN_TEXT.picker.none).toContain('ChatGPT');
    expect(SIGNIN_TEXT.picker.none).not.toMatch(/Install|Codex/);
    for (const words of [SIGNIN_TEXT.clientsNotHere, SIGNIN_TEXT.onWebNote, SIGNIN_TEXT.device.trust])
      expect(words).not.toContain('Codex');
  });

  it('says “Ready” for ChatGPT without the runner’s version, and Claude Code’s state, when given the provider', () => {
    expect(providerStateLabel({ provider: 'codex', state: 'ready', version: 'Hermes 0.22.5' })).toBe('Ready');
    expect(providerStateLabel({ provider: 'codex', state: 'missing', version: null })).not.toMatch(
      /install/i,
    );
    expect(providerStateLabel({ provider: 'claude', state: 'ready', version: '2.1.302 (Claude Code)' })).toBe(
      'Ready · 2.1.302 (Claude Code)',
    );
    expect(providerStateLabel({ provider: 'claude', state: 'missing', version: null })).toBe('Not installed');
  });
});

describe('one sign-in per provider (one-person.md OP-09)', () => {
  it('names the person’s own sign-in, never someone else’s or the organization’s', () => {
    expect(SOURCE_TEXT.title('Claude')).toContain('Your own Claude');
    for (const words of [SIGNIN_TEXT.model, SIGNIN_TEXT.signInsHelp, SOURCE_TEXT.note])
      expect(words).not.toMatch(/organization|owner|admin|everyone|whoever/i);
  });
});
