import { describe, expect, it } from 'vitest';
import { COUNCIL_TARGETS, type CouncilDraft, councilSaveBody, councilTargetChoices } from './councilDraft';

const draft: CouncilDraft = {
  seats: [
    { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'xhigh' },
    { provider: 'codex', model: 'gpt-6.2-sol', effort: 'xhigh' },
  ],
  builder: 0,
  rounds: 3,
  target: 9,
};

describe('a council in the editor', () => {
  it('offers the scores from 7 to 10 in halves, with the council’s own when it is another', () => {
    expect(councilTargetChoices(9)).toEqual([...COUNCIL_TARGETS]);
    expect(councilTargetChoices(6.5)[0]).toBe(6.5);
    expect(councilTargetChoices(6.5)).toHaveLength(COUNCIL_TARGETS.length + 1);
  });

  it('sends the contract’s fields only, the seats as they came', () => {
    const seen = { ...draft, updatedAt: '2026-11-05T12:00:00Z' } as CouncilDraft;
    const body = councilSaveBody(seen);
    expect(Object.keys(body).sort()).toEqual(['builder', 'rounds', 'seats', 'target']);
    expect(body.seats).toEqual(draft.seats);
  });
});
