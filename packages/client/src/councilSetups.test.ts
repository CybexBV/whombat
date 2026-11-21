import type { CouncilProviderOption, CouncilSetup } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  COUNCIL_SETUP_WORDS,
  councilDraft,
  councilSeatView,
  councilSetupProblem,
  effortWord,
} from './councilSetups';

const OPTIONS: CouncilProviderOption[] = [
  {
    id: 'claudeAgent',
    name: 'Claude',
    models: [
      {
        id: 'claude-opus-5-5',
        label: 'Claude Opus 5.5',
        efforts: ['low', 'high', 'xhigh'],
        defaultEffort: 'medium',
      },
      {
        id: 'claude-sonnet-5-5',
        label: 'Claude Sonnet 5.5',
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    models: [{ id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol', efforts: [], defaultEffort: null }],
  },
];

const setup = (over: Partial<CouncilSetup> = {}): CouncilSetup => ({
  seats: [
    { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'xhigh' },
    { provider: 'codex', model: 'gpt-6.1-sol', effort: null },
  ],
  builder: 0,
  rounds: 3,
  target: 9,
  updatedAt: '2026-11-05T12:00:00Z',
  ...over,
});

describe('councils in Settings', () => {
  it('says efforts in words, also the ones only T3 Code’s models take', () => {
    expect(effortWord('xhigh')).toBe('Extra high');
    expect(effortWord('ultrathink')).toBe('Ultrathink');
    expect(effortWord('turbo')).toBe('Turbo');
    expect(effortWord(null)).toBeNull();
  });

  it('says a score out of ten, halves too', () => {
    expect(COUNCIL_SETUP_WORDS.score(9)).toBe('9/10');
    expect(COUNCIL_SETUP_WORDS.score(7.5)).toBe('7.5/10');
    expect(COUNCIL_SETUP_WORDS.summary(3, 1, 8.5)).toContain('8.5/10');
  });

  it('reads a seat, and says when T3 Code can’t run it now', () => {
    const s = setup();
    expect(councilSeatView(s.seats[0] as never, OPTIONS)).toMatchObject({
      provider: 'Claude',
      line: 'Claude Opus 5.5 · Extra high',
      available: true,
    });
    expect(
      councilSeatView({ provider: 'muse', model: 'muse-wonder', effort: 'max' }, OPTIONS).available,
    ).toBe(false);
    expect(councilSeatView({ provider: 'muse', model: 'muse-wonder', effort: 'max' }, null).available).toBe(
      true,
    );
    // The model is there but no longer takes the chosen effort: said, not shown as fine.
    expect(
      councilSeatView({ provider: 'claudeAgent', model: 'claude-sonnet-5-5', effort: 'xhigh' }, OPTIONS),
    ).toMatchObject({ available: false, note: COUNCIL_SETUP_WORDS.effortNotAvailable });
    expect(
      councilSeatView({ provider: 'claudeAgent', model: 'claude-sonnet-5-5', effort: null }, OPTIONS),
    ).toMatchObject({ available: true, note: null });
    // Without T3 Code, the names kept when it was saved.
    expect(
      councilSeatView(
        {
          provider: 'muse',
          model: 'muse-wonder',
          effort: 'max',
          providerName: 'Muse Code',
          modelLabel: 'Muse Wonder',
        },
        null,
      ),
    ).toMatchObject({ provider: 'Muse Code', line: 'Muse Wonder · Max' });
  });

  it('says when T3 Code’s council isn’t two companies or sits one model twice', () => {
    const two = [
      { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'xhigh' },
      { provider: 'claudeAgent', model: 'claude-sonnet-5-5', effort: 'high' },
    ];
    expect(councilSetupProblem({ seats: two })).toContain('two different');
    const three = [...two, { provider: 'codex', model: 'gpt-6.1-sol', effort: null }];
    expect(councilSetupProblem({ seats: three })).toBeNull();
    expect(councilSetupProblem({ seats: [...three, three[0] as never] })).toContain('twice');
  });

  it('names the scores', () => {
    expect(COUNCIL_SETUP_WORDS.score(9)).toBe('9/10');
    expect(COUNCIL_SETUP_WORDS.score(8.5)).toBe('8.5/10');
  });

  it('edits the rounds and score on T3 Code’s council’s seats, the builder always its lead', () => {
    const t3 = [
      { provider: 'codex', model: 'gpt-6.2-sol', effort: 'xhigh' },
      { provider: 'antigravity', model: 'gemini-4-neon', effort: 'xhigh' },
    ];
    expect(councilDraft(null, t3)).toEqual({ seats: t3, builder: 0, rounds: 3, target: 9 });
    // Seats saved before are T3 Code's council's now; the person's rounds and score stay.
    expect(councilDraft(setup({ builder: 1, rounds: 2, target: 8 }), t3)).toEqual({
      seats: t3,
      builder: 0,
      rounds: 2,
      target: 8,
    });
    // T3 Code's council unknown: what was saved goes back unchanged.
    expect(councilDraft(setup(), []).seats).toEqual(setup().seats);
  });
});
