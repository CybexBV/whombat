/**
 * The search's tsquery across languages (docs/decisions/resourceful-agents.md RA-26, RA-DS20): English stems and the
 * words as written, English stopwords left out of the natural question's words, web-search syntax kept in each half.
 */
import { describe, expect, it } from 'vitest';
import { combinedTsQuery } from './search';

describe('combinedTsQuery', () => {
  it('matches a natural question by English stems or the words as written, any of them', () => {
    expect(combinedTsQuery('deploy failed', "'deploy' & 'fail'", "'deploy' & 'failed'", [])).toBe(
      "( 'deploy' | 'fail' ) | ( 'deploy' | 'failed' )",
    );
  });

  it('leaves English stopwords out of the words as written', () => {
    expect(
      combinedTsQuery('what about the factuur', "'factuur'", "'what' & 'about' & 'the' & 'factuur'", [
        'what',
        'about',
        'the',
      ]),
    ).toBe("'factuur'");
  });

  it('keeps web-search syntax in each half, either half matching', () => {
    expect(combinedTsQuery('"de deploy"', "'deploy'", "'de' <-> 'deploy'", [])).toBe(
      "( 'deploy' ) | ( 'de' <-> 'deploy' )",
    );
    expect(combinedTsQuery('"the who"', '', "'the' <-> 'who'", ['the', 'who'])).toBe("'the' <-> 'who'");
  });

  it('is nothing when nothing is left to search for', () => {
    expect(combinedTsQuery('the', '', "'the'", ['the'])).toBeNull();
    expect(combinedTsQuery('', '', '', [])).toBeNull();
  });
});
