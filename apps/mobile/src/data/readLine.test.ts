import { describe, expect, it } from 'vitest';
import { OLD_AFTER_MS, type ReadFacts, readLineOf, UPDATING_AFTER_MS } from './readLine';

const now = 10 * 60_000;
const facts = (over: Partial<ReadFacts>): ReadFacts => ({
  hasData: true,
  status: 'success',
  asking: false,
  dataUpdatedAt: now - 5_000,
  askingSince: null,
  ...over,
});

describe('the line over a conversation', () => {
  it('says nothing while what it shows was read just now, or while it loads for the first time', () => {
    expect(readLineOf(facts({}), now)).toBeNull();
    expect(readLineOf(facts({ asking: true, askingSince: now - 10_000 }), now)).toBeNull();
    expect(readLineOf(facts({ hasData: false, status: 'error' }), now)).toBeNull();
  });

  it('says “Updating…” once a read over old data takes a moment', () => {
    const old = { dataUpdatedAt: now - OLD_AFTER_MS, asking: true };
    expect(readLineOf(facts({ ...old, askingSince: now - 500 }), now)).toBeNull();
    expect(readLineOf(facts({ ...old, askingSince: now - UPDATING_AFTER_MS }), now)).toBe('updating');
  });

  it('says it couldn’t update when a read failed with data on screen, and “Updating…” while it is asked again', () => {
    expect(readLineOf(facts({ status: 'error' }), now)).toBe('failed');
    expect(readLineOf(facts({ status: 'error', asking: true, askingSince: now - 3_000 }), now)).toBe(
      'updating',
    );
  });
});
