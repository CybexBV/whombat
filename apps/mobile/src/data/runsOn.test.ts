import type { AgentRuntime, AgentSetupStatus, LocalModelView, ProviderModel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { LOCAL_NOT_SET_UP, modelEffortView, runsOnModel, signInLine } from './runsOn';

const status: AgentSetupStatus = {
  runner: { connected: true, seenAt: null },
  hermes: { ready: true, version: '0.22.5', problem: null, detail: null },
  providers: [
    {
      provider: 'claude',
      state: 'ready',
      version: '2.1.278 (Claude Code)',
      detail: null,
      sandboxProblem: null,
    },
    { provider: 'codex', state: 'missing', version: null, detail: null, sandboxProblem: null },
  ],
  defaultProvider: 'claude',
  checkedAt: null,
  recheckPending: false,
};
const runtime = (over: Partial<AgentRuntime> = {}): AgentRuntime => ({
  provider: 'claude',
  ...over,
});

const LOCAL: LocalModelView = {
  baseUrl: 'http://192.168.1.20:11434/v1',
  model: 'llama3.3:70b',
  label: 'Llama on the NAS',
  hasApiKey: true,
  check: { state: 'ok', at: '2026-10-23T09:00:00.000Z', models: ['qwen3:32b'], detail: null },
  updatedAt: '2026-10-23T09:00:00.000Z',
};

describe('runs on', () => {
  it('lists Claude Code and ChatGPT; Local only once the burrow has a model on its network (AP-5120)', () => {
    const plain = runsOnModel(runtime(), status, { agentName: 'Dusty', localModel: null });
    expect(plain.options.map((o) => [o.key, o.selected, o.selectable])).toEqual([
      ['claude', true, false],
      ['codex', false, false],
    ]);
    // People's names, and ChatGPT's state without anything to install (AP-5611, AP-5613).
    expect(plain.options.map((o) => o.label)).toEqual(['Claude Code', 'ChatGPT']);
    expect(plain.options[1]?.state).not.toMatch(/install/i);
    expect(plain.note).toBeNull();
    const local = runsOnModel(runtime(), status, { agentName: 'Dusty', localModel: LOCAL });
    expect(local.options[2]).toMatchObject({
      key: 'local',
      label: 'Custom',
      state: 'Llama on the NAS',
      selectable: true,
      runtime: { provider: 'local' },
    });
  });

  it('says ChatGPT is Ready without the runner’s version (AP-5613)', () => {
    const ready: AgentSetupStatus = {
      ...status,
      providers: [
        status.providers[0] as AgentSetupStatus['providers'][number],
        { provider: 'codex', state: 'ready', version: 'Hermes 0.22.5', detail: null, sandboxProblem: null },
      ],
    };
    const view = runsOnModel(runtime(), ready, { agentName: 'Dusty', localModel: null });
    expect(view.options.map((o) => o.state)).toEqual(['Ready · 2.1.278 (Claude Code)', 'Ready']);
    expect(view.options[1]?.selectable).toBe(true);
  });

  it('keeps Local shown for an agent on it after the model was removed, and says so', () => {
    const removed = runsOnModel(runtime({ provider: 'local' }), status, {
      agentName: 'Dusty',
      localModel: null,
    });
    expect(removed.options.find((o) => o.selected)).toMatchObject({ key: 'local', selectable: false });
    expect(removed.note).toBe(LOCAL_NOT_SET_UP);
  });

  it('says why the agent can’t reply when part of the Whombat isn’t ready, never naming the engine', () => {
    const broken = runsOnModel(
      runtime(),
      { ...status, hermes: { ready: false, version: null, problem: 'missing', detail: 'not found' } },
      { agentName: 'Dusty', localModel: null },
    );
    expect(broken.note).toContain('Dusty');
    expect(broken.note).toContain('missing');
    expect(broken.note).not.toMatch(/hermes/i);
  });
});

const CLAUDE_MODELS: ProviderModel[] = [
  {
    id: 'opus',
    label: 'Opus',
    description: 'Opus 5.5 · Best for everyday, complex tasks',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    isDefault: true,
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    description: 'Sonnet 5 · Fast and capable',
    efforts: ['low', 'medium', 'high'],
    isDefault: false,
  },
];
const withModels: AgentSetupStatus = {
  ...status,
  providers: status.providers.map((p) => (p.provider === 'claude' ? { ...p, models: CLAUDE_MODELS } : p)),
};

describe('model and effort (AP-1133)', () => {
  it('lists the tool’s models after the default and the levels the model takes, each with the runtime it saves', () => {
    const view = modelEffortView(
      { name: 'Banjo', runtime: runtime({ model: 'opus', effort: 'max' }) },
      withModels,
      true,
      null,
    );
    expect(view?.model).toMatchObject({
      label: 'Opus',
      description: 'Opus 5.5 · Best for everyday, complex tasks',
    });
    expect(view?.model.choices.map((c) => [c.label, c.checked, c.runtime])).toEqual([
      ['Default (Opus)', false, { provider: 'claude', effort: 'max' }],
      ['Opus', true, { provider: 'claude', model: 'opus', effort: 'max' }],
      // Sonnet goes up to High: the effort comes along within what it takes.
      ['Sonnet', false, { provider: 'claude', model: 'sonnet', effort: 'high' }],
    ]);
    expect(view?.effort?.label).toBe('Max');
    expect(view?.effort?.hint).toBe(
      'Every reply and task uses this. Higher thinks longer: slower replies and more usage.',
    );
    expect(view?.effort?.choices.map((c) => [c.label, c.detail, c.checked, c.runtime])).toEqual([
      [
        'Automatic',
        'Medium for conversations, high for code work.',
        false,
        { provider: 'claude', model: 'opus' },
      ],
      ['Low', null, false, { provider: 'claude', model: 'opus', effort: 'low' }],
      ['Medium', null, false, { provider: 'claude', model: 'opus', effort: 'medium' }],
      ['High', null, false, { provider: 'claude', model: 'opus', effort: 'high' }],
      ['Extra high', null, false, { provider: 'claude', model: 'opus', effort: 'xhigh' }],
      ['Max', null, true, { provider: 'claude', model: 'opus', effort: 'max' }],
    ]);
    expect(view?.fallback).toBeNull();
  });

  it('says when the last turn ran on the default model; the defaults read “Default (Opus)” and Automatic', () => {
    const view = modelEffortView({ name: 'Banjo', runtime: runtime() }, withModels, true, {
      model: 'sonnet',
      where: { kind: 'org', name: null },
      at: '2026-10-10T09:00:00.000Z',
    });
    expect(view?.model).toMatchObject({ label: 'Default (Opus)', description: null });
    expect(view?.effort).toMatchObject({
      label: 'Automatic',
      hint: 'Medium for conversations, high for code work.',
    });
    expect(view?.fallback).toBe(
      'Sonnet wasn’t available on the organization’s key, so Banjo used the default model for that reply.',
    );
  });

  it('shows nothing without the feature; the default only before the runner listed models', () => {
    const banjo = { name: 'Banjo', runtime: runtime() };
    expect(modelEffortView(banjo, withModels, false, null)).toBeNull();
    expect(modelEffortView(banjo, withModels, true, null)?.another).toBeNull();
    // Not listed yet: the default only (and the agent's own), every level.
    const unknown = modelEffortView(
      { name: 'Banjo', runtime: runtime({ model: 'sonnet' }) },
      status,
      true,
      null,
    );
    expect(unknown?.model.choices.map((c) => c.label)).toEqual(['Default', 'sonnet']);
    expect(unknown?.effort?.choices).toHaveLength(7);
  });
});

describe('model on Local (AP-5001, AP-5121)', () => {
  it('lists the burrow’s own model first, then the listed ones; no effort, no fast replies', () => {
    const view = modelEffortView(
      { name: 'Dusty', runtime: runtime({ provider: 'local' }) },
      status,
      true,
      null,
      true,
      LOCAL,
    );
    expect(view?.model.label).toBe('Default (Llama on the NAS)');
    expect(view?.model.choices.map((c) => [c.label, c.checked, c.runtime])).toEqual([
      ['Default (Llama on the NAS)', true, { provider: 'local' }],
      ['Llama on the NAS', false, { provider: 'local', model: 'llama3.3:70b' }],
      ['qwen3:32b', false, { provider: 'local', model: 'qwen3:32b' }],
    ]);
    expect(view?.effort).toBeNull();
    expect(view?.fast).toBeNull();
  });

  it('takes another model by its name, which then shows among the choices', () => {
    const view = modelEffortView(
      { name: 'Dusty', runtime: runtime({ provider: 'local' }) },
      status,
      true,
      null,
      false,
      LOCAL,
    );
    expect(view?.another?.runtime(' mistral-small ')).toEqual({ provider: 'local', model: 'mistral-small' });
    const typed = modelEffortView(
      { name: 'Dusty', runtime: runtime({ provider: 'local', model: 'mistral-small' }) },
      status,
      true,
      null,
      false,
      LOCAL,
    );
    expect(typed?.model.choices.find((c) => c.checked)?.label).toBe('mistral-small');
    expect(typed?.summary).toBe('mistral-small');
  });
});

describe('fast replies on Runs on (AP-2730, AP-2731)', () => {
  const fastModels: AgentSetupStatus = {
    ...status,
    providers: status.providers.map((p) =>
      p.provider === 'claude'
        ? {
            ...p,
            models: CLAUDE_MODELS.map((m) => (m.id === 'opus' ? { ...m, fast: 'off' as const } : m)),
          }
        : p,
    ),
  };

  it('offers the switch where the model has fast replies, keeping the model and effort when it saves', () => {
    const view = modelEffortView(
      { name: 'Neo', runtime: runtime({ model: 'opus', effort: 'high' }) },
      fastModels,
      true,
      null,
      true,
    );
    expect(view?.fast).toMatchObject({ on: false, label: 'Fast replies' });
    expect(view?.fast?.hint).toContain('usage credits');
    expect(view?.fast?.runtime(true)).toEqual({
      provider: 'claude',
      model: 'opus',
      effort: 'high',
      fast: true,
    });
    // Back to the model's own default: left out.
    expect(view?.fast?.runtime(false)).toEqual({ provider: 'claude', model: 'opus', effort: 'high' });
    // Another model or effort keeps it.
    const on = modelEffortView(
      { name: 'Neo', runtime: runtime({ model: 'opus', fast: true }) },
      fastModels,
      true,
      null,
      true,
    );
    expect(on?.fast?.on).toBe(true);
    expect(on?.effort?.choices.find((c) => c.label === 'High')?.runtime).toMatchObject({ fast: true });
    expect(on?.summary).toContain('Fast');
  });

  it('has none for a model without them, or on a runtime without chat.runtime', () => {
    const sonnet = { name: 'Neo', runtime: runtime({ model: 'sonnet' }) };
    expect(modelEffortView(sonnet, fastModels, true, null, true)?.fast).toBeNull();
    const opus = { name: 'Neo', runtime: runtime({ model: 'opus' }) };
    expect(modelEffortView(opus, fastModels, true, null, false)?.fast).toBeNull();
    expect(
      modelEffortView({ name: 'Neo', runtime: runtime() }, fastModels, true, null, true)?.summary,
    ).toBeNull();
  });
});

describe('SIGN-IN (OP-09, AP-5763)', () => {
  it('is your own sign-in for Claude Code and ChatGPT, and nothing on Local', () => {
    expect(signInLine({ provider: 'claude' })?.title).toContain('Claude');
    expect(signInLine({ provider: 'codex' })?.title).toContain('ChatGPT');
    expect(signInLine({ provider: 'local' })).toBeNull();
  });
});
