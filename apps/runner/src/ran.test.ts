/**
 * What a turn asks of fast replies and what its completion says it ran on (Whombat chat-runtime.md CR-06…CR-08;
 * chat-runtime-runner.md CR-R01, CR-R05…CR-R08), pure.
 */
import type { ProviderModel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { fastFor, type TurnRanFacts, turnRan } from './ran';

const MODELS: ProviderModel[] = [
  { id: 'opus', label: 'Opus', description: null, efforts: ['high'], isDefault: true, fast: 'off' },
  { id: 'sol', label: 'Sol', description: null, efforts: ['high'], isDefault: false, fast: 'on' },
  { id: 'haiku', label: 'Haiku', description: null, efforts: [], isDefault: false },
];

const facts = (extra: Partial<TurnRanFacts> = {}): TurnRanFacts => ({
  sent: { model: 'opus', effort: 'high', fast: null },
  wanted: null,
  offered: 'off',
  gateway: false,
  speed: null,
  ...extra,
});

describe('fastFor (CR-R01)', () => {
  it('the setting where the model offers fast replies; nothing otherwise', () => {
    expect(fastFor(true, MODELS, 'opus', false)).toBe(true);
    expect(fastFor(false, MODELS, 'sol', false)).toBe(false);
    // No model named: the default's.
    expect(fastFor(true, MODELS, undefined, false)).toBe(true);
    expect(fastFor(undefined, MODELS, 'sol', false)).toBeNull();
    expect(fastFor(true, MODELS, 'haiku', false)).toBeNull();
    // A model or list the runner doesn't know: nothing is sent (turnFast).
    expect(fastFor(true, MODELS, 'claude-x', false)).toBeNull();
    expect(fastFor(true, null, 'opus', false)).toBeNull();
  });

  it('never through the AI gateway (CR-R08)', () => {
    expect(fastFor(true, MODELS, 'opus', true)).toBeNull();
    expect(fastFor(false, MODELS, 'sol', true)).toBeNull();
  });
});

describe('turnRan (CR-R05…CR-R08)', () => {
  it('the model and effort sent; null for the default and for none', () => {
    expect(turnRan(facts())).toEqual({ model: 'opus', effort: 'high', fast: false });
    expect(turnRan(facts({ sent: { effort: null } }))).toEqual({ model: null, effort: null, fast: false });
  });

  it('what the provider said of its speed, with its reason when fast was asked for', () => {
    const asked = { sent: { model: 'opus', effort: 'high' as const, fast: true }, wanted: true };
    expect(turnRan(facts({ ...asked, speed: { fast: true } }))?.fast).toBe(true);
    expect(turnRan(facts({ ...asked, speed: { fast: true } }))).not.toHaveProperty('fastSkipped');
    expect(turnRan(facts({ ...asked, speed: { fast: false, skipped: 'credits' } }))).toMatchObject({
      fast: false,
      fastSkipped: 'credits',
    });
    // Not fast without a reason: unavailable.
    expect(turnRan(facts({ ...asked, speed: { fast: false } }))?.fastSkipped).toBe('unavailable');
    // Not asked: never a reason, whatever the provider said.
    expect(turnRan(facts({ speed: { fast: false, skipped: 'busy' } }))).not.toHaveProperty('fastSkipped');
  });

  it('a provider that says nothing (Codex): what was sent, else the model’s own default', () => {
    expect(turnRan(facts({ sent: { model: 'sol', fast: true }, wanted: true, offered: 'on' }))?.fast).toBe(
      true,
    );
    expect(turnRan(facts({ sent: { model: 'sol', fast: false }, offered: 'on' }))?.fast).toBe(false);
    expect(turnRan(facts({ sent: { model: 'sol' }, offered: 'on' }))?.fast).toBe(true);
    expect(turnRan(facts({ sent: { model: 'opus' }, offered: 'off' }))?.fast).toBe(false);
    expect(turnRan(facts({ sent: { model: 'x' }, offered: null }))?.fast).toBe(false);
  });

  it('through the gateway: not fast, and unavailable when it was wanted (CR-R08)', () => {
    expect(turnRan(facts({ gateway: true, offered: 'on', wanted: true }))).toMatchObject({
      fast: false,
      fastSkipped: 'unavailable',
    });
    expect(turnRan(facts({ gateway: true, offered: 'on' }))).toEqual({
      model: 'opus',
      effort: 'high',
      fast: false,
    });
  });

  it('a fallback to a default without fast replies: unavailable (CR-R07)', () => {
    expect(turnRan(facts({ sent: { effort: 'high', fast: null }, wanted: true, offered: null }))).toEqual({
      model: null,
      effort: 'high',
      fast: false,
      fastSkipped: 'unavailable',
    });
  });

  it('none that the contract would refuse', () => {
    expect(turnRan(facts({ sent: { model: 'x'.repeat(121), effort: 'high' } }))).toBeNull();
  });
});
