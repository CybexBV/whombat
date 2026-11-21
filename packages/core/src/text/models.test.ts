import { describe, expect, it } from 'vitest';
import type { ProviderModel } from '../domain/models.js';
import {
  agentEffortChangeText,
  agentModelChangeText,
  agentModelSummary,
  defaultModelLabel,
  effortLabel,
  modelFallbackText,
  modelLabel,
} from './models.js';

const models: ProviderModel[] = [
  { id: 'opus', label: 'Opus', description: null, efforts: ['low', 'high'], isDefault: true },
  { id: 'sonnet', label: 'Sonnet', description: null, efforts: ['low', 'high'], isDefault: false },
];

describe('model and effort copy (CT-333)', () => {
  it('names the default model when the list says which', () => {
    expect(defaultModelLabel(models)).toBe('Default (Opus)');
    expect(defaultModelLabel(undefined)).toBe('Default');
    expect(modelLabel(models, 'sonnet')).toBe('Sonnet');
    expect(modelLabel(models, 'claude-fable-5-1[1m]')).toBe('claude-fable-5-1[1m]');
    expect(modelLabel(models, undefined)).toBe('Default (Opus)');
  });

  it('labels efforts, automatic when none', () => {
    expect(effortLabel('xhigh')).toBe('Extra high');
    expect(effortLabel(undefined)).toBe('Automatic');
  });

  it('summarises a runtime, nothing for the defaults', () => {
    expect(agentModelSummary({ model: 'sonnet', effort: 'high' }, models)).toBe('Sonnet · High effort');
    expect(agentModelSummary({ model: 'sonnet' }, models)).toBe('Sonnet');
    expect(agentModelSummary({ effort: 'max' }, models)).toBe('Default model · Max effort');
    expect(agentModelSummary({}, models)).toBeNull();
  });

  it('writes the Keys lines', () => {
    expect(agentModelChangeText('Banjo', 'Sonnet')).toBe('Set Banjo’s model to Sonnet');
    expect(agentEffortChangeText('Banjo', null)).toBe('Set Banjo’s effort to Automatic');
    expect(agentEffortChangeText('Banjo', 'high')).toBe('Set Banjo’s effort to High');
  });

  it('says where the model wasn’t available', () => {
    expect(modelFallbackText('Banjo', 'Fable', { kind: 'account', name: 'Sara' })).toBe(
      'Fable wasn’t available on Sara’s sign-in, so Banjo used the default model for that reply.',
    );
    expect(modelFallbackText('Banjo', 'Fable', { kind: 'gateway', name: 'Fusebox' })).toBe(
      'Fable wasn’t available through Fusebox, so Banjo used the default model for that reply.',
    );
    expect(modelFallbackText('Banjo', 'Fable', { kind: 'org', name: null })).toBe(
      'Fable wasn’t available on the organization’s key, so Banjo used the default model for that reply.',
    );
  });
});
