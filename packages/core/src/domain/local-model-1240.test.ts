/** Contracts 0.124.0: the model on the person's network and Hermes's readiness (CT-1160…CT-1177; Whombat HE-32). */
import { describe, expect, it } from 'vitest';
import { parseBackupRecord } from '../backup/records.js';
import { api } from '../contracts/index.js';
import { DispatchContext, LocalModelDispatchContext } from '../contracts/runner.js';
import { CHAT_PROVIDER_LABELS } from '../text/chat-runtime.js';
import { unrunnableReply } from '../text/copy.js';
import { LOCAL_MODEL_COPY, localModelCheckText, localModelKeysText } from '../text/local-model.js';
import { modelFallbackText } from '../text/models.js';
import { turnFailureText } from '../text/turns.js';
import { AgentProvider, DEFAULT_AGENT_RUNTIME } from './agent.js';
import { EVENT_TYPES } from './audit.js';
import { Burrow } from './burrow.js';
import { CHAT_PROVIDERS, ChatRuntime, chatRuntimeOf, chatRuntimeWithModel, RanOn } from './chat-runtime.js';
import {
  LOCAL_MODEL_CHECK_STATES,
  LocalModelBaseUrl,
  type LocalModelView,
  localModelAddressProblem,
  localModelUrlProblem,
  localProviderModels,
} from './local-model.js';
import { turnEffort } from './models.js';
import { agentsCanReply, PROVIDER_LABELS, providerRunnable } from './providers.js';

const NOW = '2026-10-23T12:00:00.000Z';

const view: LocalModelView = {
  baseUrl: 'http://192.168.1.20:11434/v1',
  model: 'llama3.3:70b',
  label: 'Llama on the NAS',
  hasApiKey: true,
  check: { state: 'ok', at: NOW, models: ['qwen3:32b', 'llama3.3:70b'], detail: null },
  updatedAt: NOW,
};

describe('the provider (HE-32, CT-1150)', () => {
  it('is claude, codex or local; a new Whombat starts on Claude Code', () => {
    expect(AgentProvider.options).toEqual(['claude', 'codex', 'local']);
    for (const gone of ['acp', 'scripted']) expect(AgentProvider.safeParse(gone).success).toBe(false);
    expect(DEFAULT_AGENT_RUNTIME.provider).toBe('claude');
    expect(PROVIDER_LABELS.local).toBe('Custom AI model');
  });
});

describe('the base URL (CT-1170)', () => {
  it('takes the person’s network, Tailscale and host names', () => {
    for (const url of [
      'http://192.168.1.20:11434/v1',
      'http://10.0.0.5:8080/v1',
      'http://100.101.102.103:11434/v1',
      'http://[fd7a:115c:a1e0::1]:11434/v1',
      'http://nas.local:1234/v1',
      'https://llm.tailnet-1234.ts.net/v1',
      'https://models.example.com/v1',
    ])
      expect(localModelUrlProblem(url), url).toBeNull();
    expect(LocalModelBaseUrl.parse('  http://192.168.1.20:11434/v1 ')).toBe('http://192.168.1.20:11434/v1');
  });

  it('refuses this Whombat, metadata, plain http to the internet and bad URLs', () => {
    const cases: [string, string][] = [
      ['http://127.0.0.1:11434/v1', 'address'],
      ['http://localhost:11434/v1', 'address'],
      ['http://[::1]:11434/v1', 'address'],
      ['http://169.254.169.254/latest', 'address'],
      ['http://8.8.8.8/v1', 'http_public'],
      ['ftp://192.168.1.20/v1', 'scheme'],
      ['http://user:pw@192.168.1.20/v1', 'credentials'],
      ['http://192.168.1.20/v1?key=1', 'query'],
      ['192.168.1.20:11434', 'invalid'],
    ];
    for (const [url, code] of cases) expect(localModelUrlProblem(url), url).toBe(code);
    expect(LocalModelBaseUrl.safeParse('http://127.0.0.1:11434/v1').success).toBe(false);
  });

  it('checks the addresses a name resolved to', () => {
    expect(localModelAddressProblem('http', ['192.168.1.20'])).toBeNull();
    expect(localModelAddressProblem('https', ['203.0.114.7'])).toBeNull();
    expect(localModelAddressProblem('http', ['203.0.114.7'])).toBe('http_public');
    expect(localModelAddressProblem('http', ['192.168.1.20', '127.0.0.1'])).toBe('address');
    expect(localModelAddressProblem('http', [])).toBe('address');
  });
});

describe('what people read (CT-1170, CT-1173)', () => {
  it('is on the burrow without the key', () => {
    const burrow = Burrow.parse({
      id: 'bur_burrow-hq',
      name: 'Burrow HQ',
      slug: 'burrow-hq',
      timeZone: 'Europe/Amsterdam',
      createdAt: NOW,
      localModel: { ...view, apiKey: 'sk-secret' },
    });
    expect(burrow.localModel).toMatchObject({ model: 'llama3.3:70b', hasApiKey: true });
    expect(burrow.localModel).not.toHaveProperty('apiKey');
    expect(Burrow.parse({ ...burrow, localModel: undefined }).localModel).toBeNull();
  });

  it('offers its own model first, then what the server listed, without effort or fast replies', () => {
    const models = localProviderModels(view);
    expect(models.map((m) => [m.id, m.label, m.isDefault])).toEqual([
      ['llama3.3:70b', 'Llama on the NAS', true],
      ['qwen3:32b', 'qwen3:32b', false],
    ]);
    for (const m of models) expect([m.efforts, m.fast]).toEqual([[], null]);
    expect(turnEffort('high', 'work', models[0]?.efforts)).toBeNull();
    expect(localProviderModels(null)).toEqual([]);
    expect(localProviderModels({ ...view, label: null, check: null })).toHaveLength(1);
  });

  it('says what a test found in plain words', () => {
    for (const state of LOCAL_MODEL_CHECK_STATES) {
      const words = localModelCheckText(state, 'llama3.3:70b');
      expect(words.length).toBeGreaterThan(0);
      expect(words.toLowerCase()).not.toContain('hermes');
    }
    expect(localModelCheckText('no_model', 'llama3.3:70b')).toContain('llama3.3:70b');
    expect(LOCAL_MODEL_COPY.title).toBe('Custom AI model');
    expect(LOCAL_MODEL_COPY.hint).toMatch(/OpenRouter|Gemini/);
    expect(localModelKeysText({ actor: 'Mara', change: 'removed', name: 'x' })).toContain('Mara');
    expect(EVENT_TYPES['burrow.local_model_changed']).toBe('Keys');
  });
});

describe('turns on it (CT-1172, CT-1174)', () => {
  const status = {
    runner: { connected: true, seenAt: null },
    hermes: { ready: true, version: '0.22.5', problem: null, detail: null },
    providers: [],
  };

  it('run once the burrow has one and Hermes is ready', () => {
    expect(providerRunnable(status, 'local', view)).toBe(true);
    expect(providerRunnable(status, 'local', null)).toBe(false);
    expect(agentsCanReply(status, view)).toBe(true);
    expect(agentsCanReply(status)).toBe(false);
    const down = {
      ...status,
      hermes: { ready: false, version: null, problem: 'missing' as const, detail: null },
    };
    expect(providerRunnable(down, 'local', view)).toBe(false);
    expect(unrunnableReply({ kind: 'local' })).toContain('Settings → AI');
    expect(turnFailureText('provider', { provider: 'local' })).toContain('the custom AI model');
    expect(turnFailureText('usage_limit', { provider: 'local' })).toContain('the usage limit');
    expect(modelFallbackText('Dusty', 'qwen3:32b', { kind: 'local', name: 'Llama on the NAS' })).toContain(
      'custom AI model',
    );
  });

  it('hand the runner the address, the model and the key', () => {
    const ctx = { v: 1, baseUrl: view.baseUrl, model: 'qwen3:32b', apiKey: null };
    expect(LocalModelDispatchContext.parse(ctx)).toEqual(ctx);
    expect(LocalModelDispatchContext.safeParse({ ...ctx, v: 2 }).success).toBe(false);
    expect(DispatchContext.shape.localModel.safeParse(undefined).success).toBe(false);
  });

  it('are a choice in Chat, named Custom', () => {
    expect(CHAT_PROVIDERS).toContain('local');
    expect(CHAT_PROVIDER_LABELS.local).toBe('Custom');
    expect(chatRuntimeOf({ provider: 'local' })).toEqual({ provider: 'local' });
    const picked = chatRuntimeWithModel(
      { provider: 'local', effort: 'high', fast: true },
      'gemma3:27b',
      localProviderModels(view),
    );
    expect(picked).toEqual({ provider: 'local', model: 'gemma3:27b' });
    expect(ChatRuntime.parse({ provider: 'local', model: 'anything:7b' }).model).toBe('anything:7b');
    expect(
      RanOn.parse({ provider: 'local', model: 'qwen3:32b', modelLabel: null, effort: null, fast: false })
        .provider,
    ).toBe('local');
  });
});

describe('the person sets, tests and clears it (CT-1171)', () => {
  it('has the three ops on the burrow', () => {
    expect(api.burrows.setLocalModel).toMatchObject({ method: 'PUT', path: '/burrows/:burrow/local-model' });
    expect(api.burrows.testLocalModel).toMatchObject({
      method: 'POST',
      path: '/burrows/:burrow/local-model/test',
    });
    expect(api.burrows.clearLocalModel).toMatchObject({
      method: 'DELETE',
      path: '/burrows/:burrow/local-model',
    });
  });

  it('takes the key on the way in and never answers it', () => {
    const body = api.burrows.setLocalModel.body.parse({
      baseUrl: view.baseUrl,
      model: 'llama3.3:70b',
      apiKey: 'sk-secret',
    });
    expect(body.apiKey).toBe('sk-secret');
    expect(
      api.burrows.setLocalModel.body.safeParse({ baseUrl: 'http://127.0.0.1/v1', model: 'x' }).success,
    ).toBe(false);
    expect(api.burrows.setLocalModel.body.safeParse({ baseUrl: view.baseUrl, model: '' }).success).toBe(
      false,
    );
    expect(api.burrows.testLocalModel.body.parse({})).toEqual({});
    const answer = api.burrows.setLocalModel.response.parse({
      burrow: {
        id: 'bur_burrow-hq',
        name: 'Burrow HQ',
        slug: 'burrow-hq',
        timeZone: 'Europe/Amsterdam',
        createdAt: NOW,
        localModel: view,
      },
      localModel: { ...view, apiKey: 'sk-secret' },
      eventId: null,
    });
    expect(answer.localModel).not.toHaveProperty('apiKey');
  });

  it('is kept in a backup file with its key', () => {
    const r = parseBackupRecord('settings', {
      type: 'settings',
      name: 'Burrow HQ',
      slug: 'burrow-hq',
      timeZone: 'Europe/Amsterdam',
      localModel: { baseUrl: view.baseUrl, model: view.model, secret: 'sk-secret' },
    });
    expect(r.ok && r.record.type === 'settings' && r.record.localModel).toEqual({
      baseUrl: view.baseUrl,
      model: view.model,
      label: null,
      secret: 'sk-secret',
    });
  });
});
