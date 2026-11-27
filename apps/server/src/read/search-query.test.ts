/**
 * The search's tsquery across languages (docs/decisions/resourceful-agents.md RA-26, RA-DS20): English stems and the
 * words as written, English stopwords left out of the natural question's words, web-search syntax kept in each half.
 */
import { describe, expect, it } from 'vitest';
import { combinedTsQuery, withoutStopwords } from './search';

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

describe('withoutStopwords', () => {
  const dutch = ['de', 'het', 'andere', 'van', 'of'];

  it('leaves out the stopwords, whatever their case or punctuation', () => {
    expect(withoutStopwords('De andere facturen van Jansen', dutch)).toBe('facturen Jansen');
    expect(withoutStopwords('andere, factuur?', dutch)).toBe('factuur?');
  });

  it('keeps quoted phrases whole and a minus before a kept word', () => {
    expect(withoutStopwords('"de andere klant" -het factuur', dutch)).toBe('"de andere klant" factuur');
    expect(withoutStopwords('-Jansen de factuur', dutch)).toBe('-Jansen factuur');
  });

  it('keeps or between words and drops an or left alone', () => {
    expect(withoutStopwords('factuur or offerte', dutch)).toBe('factuur or offerte');
    expect(withoutStopwords('de or factuur', dutch)).toBe('factuur');
    expect(withoutStopwords('factuur or andere', dutch)).toBe('factuur');
  });
});
