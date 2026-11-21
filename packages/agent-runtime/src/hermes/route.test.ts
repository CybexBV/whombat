/**
 * Whether a resumed Hermes session runs on the turn's provider and model (hermes-native.md HN-07, HN-L05): Hermes's
 * picker ids as Hermes 0.22.5 says them on resume (checked 2026-10-25), with ChatGPT on Hermes's own `openai-codex`
 * (HN-02) and a Codex-mode session (`openai:<model>`) left behind.
 */
import { describe, expect, it } from 'vitest';
import { CLAUDE_GATEWAY_PROVIDER } from './claude';
import { hermesConfig } from './config';
import { hermesLoopConfig } from './own-loop';
import { hermesRouteOf, sessionFit } from './route';

const DIRECTSDK = 'claude-subscription-directsdk-experimental';

describe('the turn’s route', () => {
  it('is the provider and model its config names', () => {
    const claude = hermesConfig({ runtime: 'claude_directsdk', model: 'opus', effort: null });
    expect(hermesRouteOf(claude)).toEqual({ provider: DIRECTSDK, model: 'opus' });
    const chatgpt = hermesConfig({ runtime: 'openai_codex', model: 'gpt-6-sol', effort: null });
    expect(hermesRouteOf(chatgpt)).toEqual({ provider: 'openai-codex', model: 'gpt-6-sol' });
    const loop = hermesLoopConfig(claude, {
      kind: 'local',
      model: 'qwen3:32b',
      baseUrl: 'http://nas:11434/v1',
    });
    expect(hermesRouteOf(loop)).toMatchObject({ model: 'qwen3:32b' });
    expect(hermesRouteOf(loop).provider).toMatch(/^whombat-local-/);
  });
});

describe('a resumed session against the turn (sessionFit)', () => {
  it('the same provider and model: resumed as it is', () => {
    expect(sessionFit(`${DIRECTSDK}:opus`, { provider: DIRECTSDK, model: 'opus' })).toEqual({ fit: 'same' });
    expect(sessionFit('openai-codex:gpt-6', { provider: 'openai-codex', model: null })).toEqual({
      fit: 'same',
    });
    // A named provider of `providers:` as Hermes's ids name it, a model with colons of its own.
    expect(
      sessionFit('custom:whombat-local-1a2b3c4d:qwen3:32b', {
        provider: 'whombat-local-1a2b3c4d',
        model: 'qwen3:32b',
      }),
    ).toEqual({ fit: 'same' });
  });

  it('another model on the same provider: set in Hermes’s own id', () => {
    expect(sessionFit(`${DIRECTSDK}:sonnet`, { provider: DIRECTSDK, model: 'opus' })).toEqual({
      fit: 'model',
      from: 'sonnet',
      modelId: `${DIRECTSDK}:opus`,
    });
    expect(sessionFit('openai-codex:gpt-6', { provider: 'openai-codex', model: 'gpt-6.1' })).toMatchObject({
      modelId: 'openai-codex:gpt-6.1',
    });
    expect(
      sessionFit('custom:whombat-key-00ff00ff:claude-sonnet-5', {
        provider: 'whombat-key-00ff00ff',
        model: 'claude-opus-5-5',
      }),
    ).toMatchObject({ fit: 'model', modelId: 'custom:whombat-key-00ff00ff:claude-opus-5-5' });
  });

  it('another provider, or a retired route: not resumed', () => {
    for (const previous of ['custom:whombat-gateway-11111111', DIRECTSDK]) {
      expect(
        sessionFit(`${previous}:claude-opus-5-5`, {
          provider: CLAUDE_GATEWAY_PROVIDER,
          model: 'claude-opus-5-5',
        }),
      ).toEqual({ fit: 'provider', from: previous });
    }
    expect(sessionFit('claude-cli:opus', { provider: DIRECTSDK, model: 'opus' })).toEqual({
      fit: 'provider',
      from: 'claude-cli',
    });
    expect(sessionFit(`${DIRECTSDK}:opus`, { provider: 'openai-codex', model: 'gpt-6' })).toMatchObject({
      fit: 'provider',
    });
    // A Codex-mode session (HE-06, gone with HN-02): another provider, never resumed.
    expect(sessionFit('openai:gpt-6', { provider: 'openai-codex', model: 'gpt-6' })).toMatchObject({
      fit: 'provider',
      from: 'openai',
    });
    // The loop on another endpoint (an organisation's Anthropic key after the gateway): another name.
    expect(
      sessionFit('custom:whombat-gateway-11111111:claude-opus-5-5', {
        provider: 'whombat-key-22222222',
        model: 'claude-opus-5-5',
      }),
    ).toEqual({ fit: 'provider', from: 'custom:whombat-gateway-11111111' });
    // A session from before the loop's names said their route.
    expect(
      sessionFit('custom:whombat-model:gpt-6', { provider: 'whombat-key-22222222', model: 'gpt-6' }),
    ).toMatchObject({ fit: 'provider' });
  });

  it('Hermes says nothing, or a model without its provider: resumed as it is', () => {
    expect(sessionFit(undefined, { provider: DIRECTSDK, model: 'opus' })).toEqual({ fit: 'unknown' });
    expect(sessionFit('', { provider: DIRECTSDK, model: 'opus' })).toEqual({ fit: 'unknown' });
    expect(sessionFit('opus', { provider: DIRECTSDK, model: 'opus' })).toEqual({ fit: 'unknown' });
  });
});
