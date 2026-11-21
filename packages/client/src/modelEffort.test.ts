import type { AgentModelFallback, ProviderModel } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  agentModelLine,
  backgroundModelChoices,
  draftWithBackgroundModel,
  draftWithEffort,
  draftWithFast,
  draftWithModel,
  draftWithProvider,
  effortChoices,
  effortHint,
  fastChoice,
  modelChoices,
  modelEffortLabels,
  modelFallbackNote,
  modelRuntimeBody,
  modelRuntimeDraft,
  providerModels,
} from './modelEffort';

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Claude Code 2.1.296's list as the runner reports it (ME-04): `default` left out, Opus the default. */
const CLAUDE: ProviderModel[] = [
  {
    id: 'opus',
    label: 'Opus',
    description: 'Opus 5.5 · Best for everyday, complex tasks',
    efforts: [...CLAUDE_EFFORTS],
    isDefault: true,
  },
  {
    id: 'fable',
    label: 'Fable',
    description: 'Fable 5.1 · Most capable for long, hard work',
    efforts: [...CLAUDE_EFFORTS],
    isDefault: false,
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    description: 'Sonnet 5 · Fast and capable',
    efforts: ['low', 'medium', 'high'],
    isDefault: false,
  },
  { id: 'haiku', label: 'Haiku', description: 'Haiku 4.5 · Fastest', efforts: [], isDefault: false },
];

const draft = (over: Partial<Parameters<typeof modelRuntimeDraft>[0]> = {}) =>
  modelRuntimeDraft({ provider: 'claude', ...over });

describe('an agent’s model runtime as a draft (ME-01)', () => {
  it('reads the stored runtime; a model on the network has a model but no effort (AP-5000)', () => {
    expect(draft({ model: 'sonnet', effort: 'high' })).toEqual({
      provider: 'claude',
      model: 'sonnet',
      effort: 'high',
    });
    expect(modelRuntimeDraft({ provider: 'local', model: 'qwen3:32b', effort: 'high', fast: true })).toEqual({
      provider: 'local',
      model: 'qwen3:32b',
      effort: null,
    });
  });

  it('clears model and effort when the provider changes, not when the same one is picked again', () => {
    const banjo = draft({ model: 'sonnet', effort: 'high' });
    expect(draftWithProvider(banjo, 'claude')).toBe(banjo);
    expect(draftWithProvider(banjo, 'codex')).toEqual({ provider: 'codex', model: null, effort: null });
    expect(draftWithProvider(banjo, 'local')).toEqual({ provider: 'local', model: null, effort: null });
  });

  it('keeps a chosen effort within what a new model takes (the nearest lower, else automatic)', () => {
    const max = draft({ model: 'fable', effort: 'max' });
    expect(draftWithModel(max, 'opus', CLAUDE).effort).toBe('max');
    expect(draftWithModel(max, 'sonnet', CLAUDE)).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(draftWithModel(max, 'haiku', CLAUDE)).toMatchObject({ model: 'haiku', effort: null });
    // The default model's levels; automatic stays automatic.
    expect(draftWithModel(max, null, CLAUDE)).toMatchObject({ model: null, effort: 'max' });
    expect(draftWithModel(draft(), 'sonnet', CLAUDE).effort).toBeNull();
    // A list that isn't known (or doesn't have the model): the effort as it is.
    expect(draftWithModel(max, 'sonnet', undefined).effort).toBe('max');
    expect(draftWithModel(draft({ effort: 'ultra' }), 'claude-new', CLAUDE).effort).toBe('ultra');
    expect(draftWithEffort(max, null).effort).toBeNull();
  });

  it('saves the whole model runtime every time', () => {
    expect(modelRuntimeBody(draft({ model: 'sonnet', effort: 'high' }))).toEqual({
      provider: 'claude',
      model: 'sonnet',
      effort: 'high',
    });
    expect(modelRuntimeBody(draft())).toEqual({ provider: 'claude' });
    expect(modelRuntimeBody(draft({ effort: 'low' }))).toEqual({ provider: 'claude', effort: 'low' });
    expect(modelRuntimeBody({ provider: 'local', model: ' qwen3:32b ', effort: 'high', fast: true })).toEqual(
      {
        provider: 'local',
        model: 'qwen3:32b',
      },
    );
    expect(modelRuntimeBody({ provider: 'local', model: null, effort: null })).toEqual({ provider: 'local' });
  });
});

describe('the pickers’ choices and words (ME-06)', () => {
  it('offers “Default (Opus)” first, then the tool’s list; the agent’s own model when the list lacks it', () => {
    expect(modelChoices(CLAUDE, null).map((c) => [c.id, c.label, c.description])).toEqual([
      [null, 'Default (Opus)', null],
      ['opus', 'Opus', 'Opus 5.5 · Best for everyday, complex tasks'],
      ['fable', 'Fable', 'Fable 5.1 · Most capable for long, hard work'],
      ['sonnet', 'Sonnet', 'Sonnet 5 · Fast and capable'],
      ['haiku', 'Haiku', 'Haiku 4.5 · Fastest'],
    ]);
    expect(modelChoices(CLAUDE, 'claude-old').at(-1)).toEqual({
      id: 'claude-old',
      label: 'claude-old',
      description: null,
    });
    // Not known (an older runner): only the default, and the agent's own.
    expect(modelChoices(undefined, null)).toEqual([{ id: null, label: 'Default', description: null }]);
    expect(modelChoices(undefined, 'sonnet').map((c) => c.label)).toEqual(['Default', 'sonnet']);
  });

  it('offers Automatic and the levels the model takes; all of them while the list isn’t known', () => {
    const labels = (model: string | null, current: Parameters<typeof effortChoices>[2] = null) =>
      effortChoices(CLAUDE, model, current).map((c) => c.label);
    expect(labels(null)).toEqual(['Automatic', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
    expect(labels('sonnet')).toEqual(['Automatic', 'Low', 'Medium', 'High']);
    expect(labels('haiku')).toEqual([]);
    // A stored level the model doesn't take shows in its place.
    expect(labels('sonnet', 'max')).toEqual(['Automatic', 'Low', 'Medium', 'High', 'Max']);
    expect(effortChoices(undefined, null, null).map((c) => c.value)).toEqual([
      null,
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(effortHint(null)).toBe('Medium for conversations, high for code work.');
    expect(effortHint('high')).toBe(
      'Every reply and task uses this. Higher thinks longer: slower replies and more usage.',
    );
    expect(modelEffortLabels({ model: 'sonnet', effort: 'xhigh' }, CLAUDE)).toEqual({
      model: 'Sonnet',
      description: 'Sonnet 5 · Fast and capable',
      backgroundModel: 'Same as the main model',
      effort: 'Extra high',
    });
    expect(modelEffortLabels({ model: null, effort: null }, CLAUDE)).toEqual({
      model: 'Default (Opus)',
      description: null,
      backgroundModel: 'Same as the main model',
      effort: 'Automatic',
    });
  });

  it('reads the provider’s models from the setup status, a model on the network’s from the burrow', () => {
    const status = { providers: [{ provider: 'claude', models: CLAUDE }, { provider: 'codex' }] };
    expect(providerModels(status, 'claude')).toBe(CLAUDE);
    expect(providerModels(status, 'codex')).toBeUndefined();
    expect(providerModels(undefined, 'claude')).toBeUndefined();
    const local = { model: 'llama3.3:70b', label: 'Llama on the NAS', check: null };
    expect(providerModels(status, 'local', local)?.map((m) => [m.id, m.label, m.isDefault])).toEqual([
      ['llama3.3:70b', 'Llama on the NAS', true],
    ]);
    expect(providerModels(status, 'local', null)).toEqual([]);
  });

  it('a model on the network takes any name, no effort and no fast replies (AP-5001)', () => {
    const models = providerModels(undefined, 'local', {
      model: 'llama3.3:70b',
      label: null,
      check: { state: 'ok', at: '2026-10-23T09:00:00.000Z', models: ['qwen3:32b'], detail: null },
    });
    const local = modelRuntimeDraft({ provider: 'local' });
    expect(modelChoices(models, null).map((c) => c.label)).toEqual([
      'Default (llama3.3:70b)',
      'llama3.3:70b',
      'qwen3:32b',
    ]);
    expect(effortChoices(models, null, null)).toEqual([]);
    expect(fastChoice(local, models)).toBeNull();
    expect(draftWithModel(local, 'mistral-small', models)).toEqual({
      provider: 'local',
      model: 'mistral-small',
      effort: null,
    });
    // A typed model shows among the choices once it is the draft's.
    expect(modelChoices(models, 'mistral-small').at(-1)?.label).toBe('mistral-small');
  });

  it('says quietly when the last turn ran on the default model', () => {
    const fallback: AgentModelFallback = {
      model: 'fable',
      where: { kind: 'account', name: 'Sara' },
      at: '2026-10-10T09:00:00.000Z',
    };
    expect(modelFallbackNote('Banjo', fallback, CLAUDE)).toBe(
      'Fable wasn’t available on Sara’s sign-in, so Banjo used the default model for that reply.',
    );
    expect(
      modelFallbackNote('Banjo', { ...fallback, where: { kind: 'gateway', name: 'Fusebox' } }, undefined),
    ).toBe('fable wasn’t available through Fusebox, so Banjo used the default model for that reply.');
    expect(modelFallbackNote('Banjo', null, CLAUDE)).toBeNull();
    expect(modelFallbackNote('Banjo', undefined, CLAUDE)).toBeNull();
  });

  it('gives the profile its line, nothing for the defaults or an older runtime', () => {
    expect(agentModelLine({ provider: 'claude', model: 'sonnet', effort: 'high' }, CLAUDE, true)).toBe(
      'Sonnet · High effort',
    );
    expect(agentModelLine({ provider: 'claude', effort: 'max' }, CLAUDE, true)).toBe(
      'Default model · Max effort',
    );
    expect(agentModelLine({ provider: 'claude', model: 'opus' }, CLAUDE, true)).toBe('Opus');
    expect(agentModelLine({ provider: 'claude' }, CLAUDE, true)).toBeNull();
    expect(agentModelLine({ provider: 'claude', model: 'sonnet' }, CLAUDE, false)).toBeNull();
    expect(agentModelLine({ provider: 'local', model: 'qwen3:32b' }, [], true)).toBe('qwen3:32b');
    expect(agentModelLine(undefined, CLAUDE, true)).toBeNull();
  });
});

describe('fast replies in Configure → Model (CR-10, AP-2700)', () => {
  const FAST: ProviderModel[] = CLAUDE.map((m) => (m.id === 'opus' ? { ...m, fast: 'off' } : m));

  it('carries fast through the draft and the body, and drops it with a model that has none', () => {
    const d = draft({ fast: true });
    expect(d.fast).toBe(true);
    expect(modelRuntimeBody(d)).toEqual({ provider: 'claude', fast: true });
    expect(modelRuntimeBody(draftWithEffort(d, 'high'))).toEqual({
      provider: 'claude',
      effort: 'high',
      fast: true,
    });
    expect(draftWithModel(d, 'sonnet', FAST).fast).toBeUndefined();
    expect(draftWithModel(d, 'opus', FAST).fast).toBe(true);
    expect(draftWithModel(d, 'claude-new', FAST).fast).toBe(true);
    expect(draftWithProvider(d, 'codex').fast).toBeUndefined();
    expect(modelRuntimeDraft({ provider: 'local', fast: true }).fast).toBeUndefined();
  });

  it('shows the switch only for a model that offers it, with the provider’s hint', () => {
    expect(fastChoice(draft(), FAST)).toEqual({
      on: false,
      label: 'Fast replies',
      hint: 'Up to 2½× faster. Paid from usage credits on your Claude account, not from your plan.',
    });
    expect(fastChoice(draft({ fast: true }), FAST)?.on).toBe(true);
    expect(fastChoice(draft({ model: 'sonnet' }), FAST)).toBeNull();
    expect(fastChoice(draft(), CLAUDE)).toBeNull();
    expect(fastChoice(draft(), undefined)).toBeNull();
  });

  it('leaves fast out when it is the model’s own default', () => {
    expect(draftWithFast(draft(), true, FAST).fast).toBe(true);
    expect('fast' in draftWithFast(draft({ fast: true }), false, FAST)).toBe(false);
  });

  it('adds “· Fast” to the profile’s line', () => {
    expect(agentModelLine({ provider: 'claude', fast: true }, FAST, true)).toBe('Default model · Fast');
  });
});

describe('background model in Configure → Model', () => {
  it('carries backgroundModel through draft and body, and clears it when switching provider', () => {
    const d = draft({ model: 'opus', backgroundModel: 'haiku', effort: 'high' });
    expect(d.backgroundModel).toBe('haiku');
    expect(modelRuntimeBody(d)).toEqual({
      provider: 'claude',
      model: 'opus',
      backgroundModel: 'haiku',
      effort: 'high',
    });
    expect(draftWithModel(d, 'sonnet', CLAUDE).backgroundModel).toBe('haiku');
    expect(draftWithEffort(d, 'low').backgroundModel).toBe('haiku');
    expect(draftWithBackgroundModel(d, 'sonnet').backgroundModel).toBe('sonnet');
    expect('backgroundModel' in draftWithBackgroundModel(d, null)).toBe(false);
    expect(modelRuntimeBody(draftWithBackgroundModel(d, null))).toEqual({
      provider: 'claude',
      model: 'opus',
      effort: 'high',
    });
    expect(draftWithProvider(d, 'codex')).toEqual({ provider: 'codex', model: null, effort: null });
  });

  it('offers “Same as the main model” first, followed only by models the provider lists', () => {
    expect(backgroundModelChoices(CLAUDE, null).map((c) => [c.id, c.label])).toEqual([
      [null, 'Same as the main model'],
      ['opus', 'Opus'],
      ['fable', 'Fable'],
      ['sonnet', 'Sonnet'],
      ['haiku', 'Haiku'],
    ]);
    expect(backgroundModelChoices(undefined, null)).toEqual([
      { id: null, label: 'Same as the main model', description: null },
    ]);
    expect(backgroundModelChoices(CLAUDE, 'haiku-old').at(-1)).toEqual({
      id: 'haiku-old',
      label: 'haiku-old',
      description: null,
    });
    expect(modelEffortLabels(draft({ backgroundModel: 'haiku' }), CLAUDE).backgroundModel).toBe('Haiku');
    expect(modelEffortLabels(draft(), CLAUDE).backgroundModel).toBe('Same as the main model');
  });
});
