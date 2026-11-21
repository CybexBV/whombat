import { describe, expect, it } from 'vitest';
import { agentPartOfTab, agentParts, resolvePart, validateAgentPart } from '../parts';
import { modelSavedText, sameDraft } from './model';

describe('Model & provider’s save toast (AP-1129)', () => {
  const claude = { provider: 'claude' } as const;
  it('names what changed: the provider, its model and effort, or both', () => {
    expect(modelSavedText('Banjo', claude, { ...claude, model: 'sonnet', effort: null })).toBe(
      'Updated Banjo’s model and effort.',
    );
    expect(modelSavedText('Banjo', claude, { provider: 'codex', model: null, effort: null })).toBe(
      'Updated Banjo’s AI provider.',
    );
    expect(modelSavedText('Banjo', claude, { provider: 'codex', model: null, effort: 'high' })).toBe(
      'Updated Banjo’s AI provider, model and effort.',
    );
    expect(modelSavedText('Banjo', claude, { provider: 'local', model: 'qwen3:32b', effort: null })).toBe(
      'Updated Banjo’s AI provider and model.',
    );
    const local = { provider: 'local' } as const;
    expect(modelSavedText('Banjo', local, { ...local, model: 'qwen3:32b', effort: null })).toBe(
      'Updated Banjo’s model.',
    );
  });
});

describe('drafts (AP-385)', () => {
  it('compares drafts by value', () => {
    expect(sameDraft({ keys: { a: true, b: false } }, { keys: { b: false, a: true } })).toBe(true);
    expect(sameDraft({ name: 'Banjo', job: undefined }, { name: 'Banjo' })).toBe(true);
    expect(sameDraft({ keys: { a: true } }, { keys: { a: false } })).toBe(false);
  });
});

describe('Settings → Agent’s parts (one-agent.md AP-4923)', () => {
  const all = { spend: true, services: true };
  it('has every part, in order; Spend and Running where they show', () => {
    expect(agentParts(all)).toEqual(['profile', 'model', 'keys', 'notes', 'services', 'schedules', 'spend']);
    expect(agentParts({ spend: false, services: false })).toEqual([
      'profile',
      'model',
      'keys',
      'notes',
      'schedules',
    ]);
  });

  it('shows Name and character for a part that doesn’t show, and reads the old tabs', () => {
    expect(resolvePart('spend', agentParts({ ...all, spend: false }))).toBe('profile');
    expect(resolvePart(undefined, agentParts(all))).toBe('profile');
    expect(validateAgentPart('keys')).toBe('keys');
    expect(validateAgentPart('profile')).toBeUndefined();
    expect(validateAgentPart('danger')).toBeUndefined();
    expect([agentPartOfTab('access'), agentPartOfTab('danger'), agentPartOfTab('workspace')]).toEqual([
      'keys',
      undefined,
      undefined,
    ]);
  });
});
