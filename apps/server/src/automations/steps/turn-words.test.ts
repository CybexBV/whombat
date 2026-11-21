/**
 * What an agent step says about its turn (docs/decisions/outsiders-turns.md): why it waits behind another outsiders'
 * turn, and why it failed — the facts each line must carry, not its sentences.
 */
import { HERMES_PROFILE_BUSY } from '@whombat/agent-runtime/failures';
import { describe, expect, it } from 'vitest';
import { queuedNoteOf, queuedSummary, turnFailedWords, turnWaitsWords } from './turn-words';

describe('why a step’s turn waits', () => {
  it('names what it waits for, a customer’s report or a website’s feedback', () => {
    expect(turnWaitsWords({ trigger: 'automation' })).toMatch(/customer report/);
    expect(turnWaitsWords({ trigger: 'feedback' })).toMatch(/feedback report/);
  });

  it('keeps what it asked, after which the note goes', () => {
    expect(queuedSummary('Asked Dusty', 'Waiting')).toBe('Asked Dusty · Waiting');
    expect(queuedSummary('', 'Waiting')).toBe('Waiting');
    expect(queuedNoteOf({ queuedBehind: { note: 'Waiting', asked: 'Asked Dusty' } })).toEqual({
      note: 'Waiting',
      asked: 'Asked Dusty',
    });
    expect(queuedNoteOf({ agentId: 'prn_dusty' })).toBeNull();
    expect(queuedNoteOf(null)).toBeNull();
  });
});

describe('why a step’s turn failed', () => {
  it('says the recorded failure’s reason after the agent’s name', () => {
    const line = turnFailedWords('Dusty', { failure: { code: 'timeout' }, error: 'whatever' });
    expect(line.startsWith('Dusty couldn’t finish because')).toBe(true);
    expect(line).toMatch(/too long/);
    expect(turnFailedWords('Dusty', { failure: { code: 'refused' } })).toMatch(/wouldn’t answer/);
    expect(turnFailedWords('Dusty', { failure: { code: 'usage_limit' } })).toMatch(/usage limit/);
  });

  it('reads the reason from the error when no failure is recorded yet', () => {
    expect(turnFailedWords('Dusty', { failure: null, error: 'API Error: 529 overloaded' })).toMatch(
      /AI service/,
    );
    expect(turnFailedWords('Dusty', { error: 'managed:wall_time' })).toMatch(/too long/);
    expect(turnFailedWords('Dusty', { error: 'lease_expired' })).toMatch(/interrupted/);
  });

  it('says the profile stayed busy in plain words, never the runner’s own', () => {
    const line = turnFailedWords('Dusty', { failure: { code: 'internal' }, error: HERMES_PROFILE_BUSY });
    expect(line).toMatch(/waiting/);
    expect(line).not.toContain('your conversations');
  });

  it('says only that it couldn’t finish when nothing says why', () => {
    expect(turnFailedWords('Dusty', { failure: { code: 'internal' }, error: 'boom' })).toBe(
      'Dusty couldn’t finish.',
    );
    expect(turnFailedWords('Dusty', {})).toBe('Dusty couldn’t finish.');
  });
});
