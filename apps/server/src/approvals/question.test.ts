import { describe, expect, it } from 'vitest';
import { asQuestion } from './create';

describe('asQuestion', () => {
  it('ends an approval question with exactly one question mark', () => {
    expect(asQuestion('Post the rounding note')).toBe('Post the rounding note?');
    expect(asQuestion('Post the rounding note?')).toBe('Post the rounding note?');
    expect(asQuestion('Ship it?? ')).toBe('Ship it?');
  });
});
