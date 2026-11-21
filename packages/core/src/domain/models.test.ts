import { describe, expect, it } from 'vitest';
import { AgentModelRuntime, AgentRuntime } from './agent.js';
import {
  AGENT_EFFORTS,
  AgentModelFallback,
  effortsFor,
  modelOf,
  type ProviderModel,
  ProviderModel as ProviderModelSchema,
  turnEffort,
} from './models.js';
import { ProviderCheck } from './providers.js';

const claude: ProviderModel[] = [
  {
    id: 'opus',
    label: 'Opus',
    description: 'Opus 5.5 · Best for everyday, complex tasks',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    isDefault: true,
  },
  { id: 'haiku', label: 'Haiku', description: null, efforts: ['low', 'medium', 'high'], isDefault: false },
  { id: 'tiny', label: 'Tiny', description: null, efforts: [], isDefault: false },
];

describe('turnEffort (CT-333)', () => {
  it('is automatic without a setting: high for code work, medium for conversation', () => {
    expect(turnEffort(undefined, 'work')).toBe('high');
    expect(turnEffort(null, 'chat')).toBe('medium');
  });

  it('takes the agent’s own for every kind of turn', () => {
    expect(turnEffort('max', 'chat')).toBe('max');
    expect(turnEffort('low', 'work')).toBe('low');
  });

  it('stays within what the model takes: the nearest lower, else the nearest higher', () => {
    expect(turnEffort('max', 'chat', ['low', 'medium', 'high'])).toBe('high');
    expect(turnEffort('ultra', 'work', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('max');
    expect(turnEffort('low', 'work', ['high', 'max'])).toBe('high');
    expect(turnEffort(undefined, 'work', ['medium'])).toBe('medium');
  });

  it('sends none for a model that takes none', () => {
    expect(turnEffort('high', 'work', [])).toBeNull();
  });
});

describe('modelOf and effortsFor', () => {
  it('finds the named model, else the default', () => {
    expect(modelOf(claude, 'haiku')?.label).toBe('Haiku');
    expect(modelOf(claude, undefined)?.id).toBe('opus');
    expect(modelOf(claude, 'gone')).toBeNull();
    expect(modelOf(undefined, 'opus')).toBeNull();
  });

  it('offers the model’s efforts, every effort while the list is unknown', () => {
    expect(effortsFor(claude, 'haiku')).toEqual(['low', 'medium', 'high']);
    expect(effortsFor(claude, null)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortsFor(undefined, 'opus')).toEqual(AGENT_EFFORTS);
    expect(effortsFor(claude, 'tiny')).toEqual([]);
  });
});

describe('schemas', () => {
  it('a runtime with an effort parses; one stored before it still does', () => {
    expect(AgentModelRuntime.parse({ provider: 'claude', model: 'sonnet', effort: 'high' })).toEqual({
      provider: 'claude',
      model: 'sonnet',
      effort: 'high',
    });
    expect(AgentRuntime.parse({ provider: 'codex' }).effort).toBeUndefined();
    expect(() => AgentModelRuntime.parse({ provider: 'claude', effort: 'turbo' })).toThrow();
  });

  it('a provider check carries its models; an older one without', () => {
    const check = { provider: 'claude', state: 'ready', version: '2.1.296 (Claude Code)', detail: null };
    expect(ProviderCheck.parse({ ...check, models: claude }).models).toHaveLength(3);
    expect(ProviderCheck.parse(check).models).toBeUndefined();
    expect(() => ProviderModelSchema.parse({ ...claude[0], id: '' })).toThrow();
  });

  it('a fallback names where the model wasn’t available', () => {
    const fallback = {
      model: 'fable',
      where: { kind: 'account', name: 'Sara' },
      at: '2026-10-10T12:00:00.000Z',
    };
    expect(AgentModelFallback.parse(fallback)).toEqual(fallback);
  });
});
